//! Cliente web (client/dist) embutido no binário: um único executável serve tudo.
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../client/dist"]
struct ClientDist;

/// O navegador aceita `enc` no `Accept-Encoding` (e não o recusou com `q=0`).
fn accepts(accept: &str, enc: &str) -> bool {
    accept.split(',').any(|part| {
        let mut it = part.split(';');
        it.next().map(str::trim) == Some(enc) && !it.any(|q| matches!(q.trim(), "q=0" | "q=0.0" | "q=0.00" | "q=0.000"))
    })
}

fn serve(path: &str, accept: &str) -> Option<Response> {
    let file = ClientDist::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    // Arquivos com hash no nome (assets/) podem ficar em cache para sempre.
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    // O build já deixa o JS, o CSS e o HTML comprimidos ao lado (`.br` e `.gz`, veja vite.config.js): o
    // servidor só escolhe a versão, sem gastar CPU. No celular a abertura baixa um quarto do tamanho.
    for (enc, ext) in [("br", "br"), ("gzip", "gz")] {
        if !accepts(accept, enc) {
            continue;
        }
        if let Some(packed) = ClientDist::get(&format!("{path}.{ext}")) {
            let headers = [
                (header::CONTENT_TYPE, mime.as_ref()),
                (header::CACHE_CONTROL, cache),
                (header::CONTENT_ENCODING, enc),
                (header::VARY, "Accept-Encoding"),
            ];
            return Some((headers, packed.data).into_response());
        }
    }
    let headers = [(header::CONTENT_TYPE, mime.as_ref()), (header::CACHE_CONTROL, cache), (header::VARY, "Accept-Encoding")];
    Some((headers, file.data).into_response())
}

fn not_built() -> Response {
    (StatusCode::NOT_FOUND, "Cliente web não compilado. Rode `npm run build` e recompile o servidor.").into_response()
}

fn accept_encoding(headers: &HeaderMap) -> &str {
    headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// Fallback de SPA do servidor de chat: arquivo estático se existir, senão `index.html`.
pub async fn static_handler(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({ "error": "Rota não encontrada" }))).into_response();
    }
    let accept = accept_encoding(&headers);
    serve(if path.is_empty() { "index.html" } else { path }, accept)
        // Páginas avulsas sem a extensão: /privacidade → privacidade.html, /termos → termos.html.
        .or_else(|| (!path.is_empty() && !path.contains('.') && !path.contains('/')).then(|| serve(&format!("{path}.html"), accept)).flatten())
        .or_else(|| serve("index.html", accept))
        .unwrap_or_else(not_built)
}

/// Mesmo cliente, mas marcado como painel de hospedagem (abre direto na página "Hostear").
pub async fn panel_handler(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty() && path != "index.html" {
        if let Some(r) = serve(path, accept_encoding(&headers)) {
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

#[cfg(test)]
mod tests {
    use super::accepts;

    #[test]
    fn escolhe_a_compressao_que_o_navegador_aceita() {
        assert!(accepts("gzip, deflate, br, zstd", "br"));
        assert!(accepts("gzip;q=1.0, br;q=0.8", "gzip"));
        assert!(!accepts("gzip, deflate", "br"));
        assert!(!accepts("br;q=0, gzip", "br"));
        assert!(!accepts("", "gzip"));
        assert!(!accepts("x-gzip", "gzip"));
    }
}
