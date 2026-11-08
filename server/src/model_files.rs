//! Arquivos pesados dos recursos que rodam no aparelho (por enquanto, o reconhecimento de gestos da câmera: o wasm
//! do MediaPipe e o modelo `.task`). Ficam fora do app (que vai embutido no servidor e no instalador do Windows),
//! numa pasta (`MODELS_DIR`, ou `DATA_DIR/models`) com um `manifest.json`; o app baixa na primeira vez que usa,
//! confere o SHA-256 e guarda.
//!
//! Sem login: são arquivos abertos, e um app conectado a outro servidor pode buscar aqui. O envio é em pedaços
//! (o servidor da VM tem pouca memória) e no máximo `SLOTS` downloads ao mesmo tempo.
use crate::host::App;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Semaphore;

/// Downloads ao mesmo tempo (o manifesto não conta).
static SLOTS: Semaphore = Semaphore::const_new(4);

pub fn router() -> Router<Arc<App>> {
    Router::new().route("/api/models/{name}", get(serve))
}

/// A pasta dos arquivos.
pub fn dir(app: &App) -> PathBuf {
    match std::env::var("MODELS_DIR") {
        Ok(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => app.data_dir.join("models"),
    }
}

/// Este servidor tem os arquivos (vai no `/api/config`).
pub fn available(app: &App) -> bool {
    dir(app).join("manifest.json").is_file()
}

/// Nome aceito: letras minúsculas, números, ponto, hífen e sublinhado (sem caminho).
fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 121
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'_'))
        && !name.contains("..")
}

/// A versão comprimida a mandar (`br` ou `gz`), só para wasm/js/json e se o navegador aceita.
fn encoding_for(name: &str, accept: &str) -> Option<&'static str> {
    if !(name.ends_with(".wasm") || name.ends_with(".js") || name.ends_with(".json")) {
        return None;
    }
    let accepts = |enc: &str| accept.split(',').any(|p| p.split(';').next().unwrap_or_default().trim().eq_ignore_ascii_case(enc));
    if accepts("br") {
        Some("br")
    } else if accepts("gzip") {
        Some("gz")
    } else {
        None
    }
}

fn content_type(name: &str) -> &'static str {
    if name.ends_with(".wasm") {
        "application/wasm"
    } else if name.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if name.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

async fn serve(State(app): State<Arc<App>>, Path(name): Path<String>, headers: HeaderMap) -> Response {
    if !valid_name(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let base = dir(&app);
    let plain = base.join(&name);
    if !plain.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let manifest = name == "manifest.json";
    let permit = if manifest {
        None
    } else {
        match SLOTS.try_acquire() {
            Ok(p) => Some(p),
            Err(_) => {
                let mut res = (StatusCode::SERVICE_UNAVAILABLE, "Muitos downloads agora; tente de novo").into_response();
                res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
                return res;
            }
        }
    };
    let accept = headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let (path, enc) = match encoding_for(&name, accept) {
        Some(enc) if base.join(format!("{name}.{enc}")).is_file() => (base.join(format!("{name}.{enc}")), Some(enc)),
        _ => (plain, None),
    };
    let Ok(file) = tokio::fs::File::open(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    // o lugar no semáforo vai junto com o corpo e só sai quando o download termina (ou cai)
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 << 10);
    let stream = futures_util::StreamExt::map(stream, move |chunk| {
        let _hold = &permit;
        chunk
    });
    let mut res = Response::new(Body::from_stream(stream));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&name)));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if manifest { "no-cache" } else { "public, max-age=31536000, immutable" }),
    );
    if let Some(enc) = enc {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static(if enc == "br" { "br" } else { "gzip" }));
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomes_e_compressao() {
        assert!(valid_name("manifest.json") && valid_name("mp-gesture-9795234.task") && valid_name("vision_wasm-1.2.2.wasm"));
        for bad in ["", "../x", "a/b", "a\\b", "Maiuscula.js", ".oculto", "a..b", &"x".repeat(130)] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert_eq!(encoding_for("a.wasm", "gzip, deflate, br"), Some("br"));
        assert_eq!(encoding_for("a.js", "gzip"), Some("gz"));
        assert_eq!(encoding_for("a.task", "br"), None);
        assert_eq!(encoding_for("m.tar.gz", "br"), None);
        assert_eq!(encoding_for("a.wasm", "identity"), None);
        assert_eq!(content_type("a.wasm"), "application/wasm");
    }
}
