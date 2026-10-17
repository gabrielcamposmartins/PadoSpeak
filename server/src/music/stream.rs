//! Áudio das faixas: URL direta via yt-dlp e proxy HTTP com suporte a Range (seek).
use super::tools::Tools;
use super::Source;
use crate::host::App;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// As URLs do googlevideo expiram em ~6 h; renovamos antes.
pub const AUDIO_TTL: Duration = Duration::from_secs(5 * 3600);

#[derive(Clone, Debug)]
pub struct Audio {
    pub url: String,
    pub duration_ms: Option<u64>,
    pub fetched: Instant,
}

/// Clientes do YouTube, na ordem em que tentamos. O padrão às vezes entrega uma URL que só serve o
/// primeiro 1 MB (falta o "PO token" do cliente web) ou que vem lenta demais: aí vale o próximo.
/// `tv_simply` e `mweb` costumam vir só com o MP4 de 360p (vídeo junto), por isso ficam por último.
pub const CLIENTS: [Option<&str>; 4] = [None, Some("web_embedded"), Some("tv_simply"), Some("mweb")];

/// O melhor áudio (Opus/WebM quando disponível).
const FORMAT: &str = "bestaudio[acodec=opus]/bestaudio/best";

/// Pede ao yt-dlp a URL direta do melhor áudio, com o cliente `client` (None: o padrão).
pub async fn resolve_audio(tools: &Tools, source: &Source, client: Option<&str>) -> Result<Audio, String> {
    let target = match source {
        Source::Youtube(url) => url.clone(),
        Source::Search(q) => format!("ytsearch1:{q}"),
    };
    let args = ["-f", FORMAT, "--no-playlist", "--print", "%(is_live)s %(protocol)s", "--print", "%(url)s", "--print", "%(duration)s", &target];
    let timeout = Duration::from_secs(60);
    let stdout = match client {
        None => tools.run(&args, timeout).await?,
        Some(c) => tools.run_client(c, &args, timeout).await?,
    };
    let stdout = String::from_utf8_lossy(&stdout);
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    // Ao vivo (ou só em lista HLS, que o `<audio>` não toca): a música ficaria "tocando" sem som.
    let kind = lines.next().unwrap_or_default();
    if kind.starts_with("True") || kind.contains("m3u8") {
        return Err("é uma transmissão ao vivo, e a fila só toca vídeos".into());
    }
    match lines.next() {
        Some(url) if url.starts_with("http") => Ok(Audio {
            url: url.to_string(),
            duration_ms: lines.next().and_then(|d| d.parse::<f64>().ok()).map(|s| (s * 1000.0) as u64),
            fetched: Instant::now(),
        }),
        _ => Err("nenhum resultado no YouTube".into()),
    }
}

/// A URL entrega o arquivo inteiro, e rápido? Pede 256 KB do meio (onde a URL sem "PO token" já é
/// recusada) e mede: menos de ~100 KB/s não acompanha quem entra no meio da música.
pub async fn probe_audio(http: &reqwest::Client, url: &str) -> bool {
    let len = url
        .split_once('?')
        .and_then(|(_, q)| q.split('&').find_map(|kv| kv.strip_prefix("clen=")))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let start = len / 2;
    let end = start + 256 * 1024 - 1;
    let req = http.get(url).header(header::RANGE, format!("bytes={start}-{end}")).timeout(Duration::from_secs(4));
    let Ok(res) = req.send().await else { return false };
    if !res.status().is_success() {
        return false;
    }
    let began = Instant::now();
    match tokio::time::timeout(Duration::from_millis(2600), res.bytes()).await {
        Ok(Ok(body)) => !body.is_empty() && began.elapsed() < Duration::from_millis(2600),
        _ => false,
    }
}

/// A URL do googlevideo vem presa ao IP de quem a resolveu (`ip=` na query): o proxy precisa
/// sair pela mesma família (IPv4 ou IPv6).
pub fn locked_ip_is_v6(url: &str) -> Option<bool> {
    let query = url.split_once('?')?.1;
    let ip = query.split('&').find_map(|kv| kv.strip_prefix("ip="))?;
    Some(ip.contains(':') || ip.contains("%3A") || ip.contains("%3a"))
}

#[derive(Deserialize)]
pub struct StreamQuery {
    token: String,
}

/// `GET /api/music/stream/{trackId}?token=…` — o `<audio>` não envia cabeçalhos, por isso o token vai na query.
pub async fn handler(
    State(app): State<Arc<App>>,
    Path(track_id): Path<String>,
    Query(q): Query<StreamQuery>,
    headers: HeaderMap,
) -> Response {
    if crate::auth::user_from_token(&app.db, &q.token).await.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let range = headers.get(header::RANGE).cloned();
    for attempt in 0..2 {
        let url = match app.music.audio_url(&track_id, attempt > 0).await {
            Ok(u) => u,
            Err(e) => return (StatusCode::NOT_FOUND, e).into_response(),
        };
        let mut req = app.music.http_for(&url).get(&url);
        if let Some(r) = &range {
            req = req.header(header::RANGE, r.clone());
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
        };
        // URL expirada ou recusada: resolve de novo uma vez.
        if matches!(res.status().as_u16(), 403 | 410) && attempt == 0 {
            continue;
        }
        let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let mut out = Response::builder().status(status);
        for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
            if let Some(v) = res.headers().get(name.as_str()).and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
                out = out.header(name, v);
            }
        }
        out = out.header(header::CACHE_CONTROL, "no-store");
        return out.body(Body::from_stream(res.bytes_stream())).unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
    (StatusCode::BAD_GATEWAY, "o YouTube recusou o áudio").into_response()
}

#[cfg(test)]
mod tests {
    use super::locked_ip_is_v6;

    #[test]
    fn familia_do_ip_da_url() {
        assert_eq!(locked_ip_is_v6("https://rr1.googlevideo.com/videoplayback?expire=1&ip=179.209.142.113&id=x"), Some(false));
        assert_eq!(locked_ip_is_v6("https://rr1.googlevideo.com/videoplayback?ip=2804%3A14c%3Ae1&id=x"), Some(true));
        assert_eq!(locked_ip_is_v6("https://exemplo.com/audio.webm"), None);
    }
}
