//! Música buscada pelo nó de mídia. O nó resolve com o yt-dlp dele e busca o áudio (a URL do googlevideo
//! fica presa ao IP de quem resolveu), e manda os bytes por um WebSocket que ele mesmo abre aqui
//! (`/api/media/stream/{ticket}`): o nó atrás de um roteador não precisa de porta aberta. O proxy da música
//! (`crate::music::stream::handler`) entrega aos apps como sempre, com Range (pular na música).
use crate::host::App;
use crate::music::Source;
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message as WsMessage, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

const PREFIX: &str = "node:";
/// O nó tem este tempo para começar a mandar o áudio (ele pode precisar resolver de novo).
const OPEN_TIMEOUT: Duration = Duration::from_secs(45);

/// A "URL" de uma faixa resolvida pelo nó (guardada no lugar da do googlevideo).
pub fn make_node_url(node: &str, key: &str) -> String {
    format!("{PREFIX}{node}:{key}")
}

/// `(nó, faixa)` de uma URL feita por `make_node_url`.
pub fn node_url(url: &str) -> Option<(&str, &str)> {
    url.strip_prefix(PREFIX)?.split_once(':')
}

/// O nó chegou com o áudio de um pedido.
pub async fn stream_ws(ws: WebSocketUpgrade, State(app): State<Arc<App>>, Path(ticket): Path<String>) -> Response {
    if !app.media.awaits_stream(&ticket) {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.max_message_size(4 << 20).on_upgrade(move |socket| async move {
        app.media.deliver_stream(&ticket, socket);
    })
}

/// Pede o áudio da faixa ao nó e entrega ao app. `range`: o pedaço que o `<audio>` pediu.
pub async fn serve(app: &Arc<App>, node: &str, key: &str, source: &Source, range: Option<HeaderValue>) -> Response {
    let bad = |text: &str| (StatusCode::BAD_GATEWAY, text.to_string()).into_response();
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let rx = app.media.expect_stream(&ticket);
    let range = range.and_then(|r| r.to_str().ok().map(str::to_string));
    app.media.cmd(node, "music.fetch", json!({ "ticket": ticket, "key": key, "source": source, "range": range }));
    let ws = match tokio::time::timeout(OPEN_TIMEOUT, rx).await {
        Ok(Ok(ws)) => ws,
        _ => {
            app.media.forget_stream(&ticket);
            return bad("o nó de mídia não mandou a música");
        }
    };
    let (sink, mut stream) = ws.split();
    // Primeiro a resposta do googlevideo (situação e cabeçalhos), depois os bytes.
    let head = match tokio::time::timeout(Duration::from_secs(15), stream.next()).await {
        Ok(Some(Ok(WsMessage::Text(t)))) => serde_json::from_str::<Value>(&t).unwrap_or(Value::Null),
        _ => return bad("o nó de mídia não mandou a música"),
    };
    let status = head.get("status").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::BAD_GATEWAY);
    if !status.is_success() {
        return (status, head.get("error").and_then(Value::as_str).unwrap_or("o YouTube recusou o áudio").to_string()).into_response();
    }
    let mut out = Response::builder().status(status);
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
        if let Some(v) = head.get("headers").and_then(|h| h.get(name.as_str())).and_then(Value::as_str).and_then(|v| HeaderValue::from_str(v).ok()) {
            out = out.header::<HeaderName, HeaderValue>(name, v);
        }
    }
    out = out.header(header::CACHE_CONTROL, "no-store");
    // A metade de envio fica junto (sem ela, a conexão fecharia antes do fim).
    let body = futures_util::stream::unfold((stream, sink), |(mut stream, sink)| async move {
        loop {
            match stream.next().await {
                Some(Ok(WsMessage::Binary(b))) => {
                    crate::media::load::MUSIC_BYTES.fetch_add(b.len() as u64, Ordering::Relaxed);
                    return Some((Ok::<Bytes, std::io::Error>(b), (stream, sink)));
                }
                Some(Ok(WsMessage::Close(_))) | None => return None,
                Some(Err(e)) => return Some((Err(std::io::Error::other(e.to_string())), (stream, sink))),
                _ => continue,
            }
        }
    });
    out.body(Body::from_stream(body)).unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_do_no_vai_e_volta() {
        let u = make_node_url("abc123", "faixa-1");
        assert_eq!(node_url(&u), Some(("abc123", "faixa-1")));
        assert_eq!(node_url("https://rr1.googlevideo.com/x"), None);
    }
}
