//! Cliente web (client/dist) embutido no binário: um único executável serve tudo.
use axum::http::{header, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../client/dist"]
struct ClientDist;

fn serve(path: &str) -> Option<Response> {
    let file = ClientDist::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Arquivos com hash no nome (assets/) podem ficar em cache para sempre.
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    Some(([(header::CONTENT_TYPE, mime.as_ref()), (header::CACHE_CONTROL, cache)], file.data).into_response())
}

fn not_built() -> Response {
    (StatusCode::NOT_FOUND, "Cliente web não compilado. Rode `npm run build` e recompile o servidor.").into_response()
}

/// Fallback de SPA do servidor de chat: arquivo estático se existir, senão `index.html`.
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "Rota não encontrada" }))).into_response();
    }
    serve(if path.is_empty() { "index.html" } else { path })
        .or_else(|| serve("index.html"))
        .unwrap_or_else(not_built)
}

/// Mesmo cliente, mas marcado como painel de hospedagem (abre direto na página "Hostear").
pub async fn panel_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty() && path != "index.html" {
        if let Some(r) = serve(path) {
            return r;
        }
    }
    match ClientDist::get("index.html") {
        Some(f) => {
            let html = String::from_utf8_lossy(&f.data)
                .replacen("<head>", "<head><script>window.__PADOSPEAK_PANEL__=true</script>", 1);
            ([(header::CACHE_CONTROL, "no-cache")], Html(html)).into_response()
        }
        None => not_built(),
    }
}
