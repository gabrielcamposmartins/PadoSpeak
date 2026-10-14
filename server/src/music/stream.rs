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

/// Pede ao yt-dlp a URL direta do melhor áudio (Opus/WebM quando disponível).
pub async fn resolve_audio(tools: &Tools, source: &Source) -> Result<Audio, String> {
    let target = match source {
        Source::Youtube(url) => url.clone(),
        Source::Search(q) => format!("ytsearch1:{q}"),
    };
    let args = ["-f", "bestaudio[acodec=opus]/bestaudio/best", "--no-playlist", "--print", "%(url)s", "--print", "%(duration)s", &target];
    let stdout = tools.run(&args, Duration::from_secs(60)).await?;
    let stdout = String::from_utf8_lossy(&stdout);
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    match lines.next() {
        Some(url) if url.starts_with("http") => Ok(Audio {
            url: url.to_string(),
            duration_ms: lines.next().and_then(|d| d.parse::<f64>().ok()).map(|s| (s * 1000.0) as u64),
            fetched: Instant::now(),
        }),
        _ => Err("nenhum resultado no YouTube".into()),
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
