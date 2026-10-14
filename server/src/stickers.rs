//! Stickers: cada pessoa tem a sua coleção (PNG, JPEG, WebP ou GIF animado) e manda numa conversa
//! como uma mensagem `[sticker:<id>]`. A imagem é pública pelo id (o `<img>` não manda cabeçalho de
//! autenticação), como as fotos de perfil.
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Tamanho máximo de um sticker (GIF animado incluso).
const MAX_STICKER: usize = 2 * 1024 * 1024;
/// Stickers por pessoa (num servidor).
const MAX_PER_USER: i64 = 200;

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route(
            "/api/stickers",
            get(list).post(upload).layer(DefaultBodyLimit::max(MAX_STICKER + 64 * 1024)),
        )
        .route("/api/stickers/{id}", delete(remove))
        .route("/api/stickers/{id}/image", get(image))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sticker {
    id: String,
    name: String,
    mime: String,
    url: String,
    animated: bool,
}

fn sticker(id: String, name: String, mime: String) -> Sticker {
    Sticker { url: format!("/api/stickers/{id}/image"), animated: mime == "image/gif", id, name, mime }
}

fn bad(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}

/// FNV-1a de 64 bits: reconhece o mesmo arquivo enviado de novo (cópia entre servidores, clique duplo).
fn fingerprint(data: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}-{}", data.len())
}

async fn list(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Vec<Sticker>>> {
    let rows = app
        .db
        .query_all(
            "SELECT id, name, mime FROM stickers WHERE owner_id = ?1 ORDER BY created_at",
            [me.id.as_str()],
            |r| Ok(sticker(r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    name: String,
}

async fn upload(
    State(app): AppState,
    AuthUser(me, _): AuthUser,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Sticker>)> {
    if body.is_empty() || body.len() > MAX_STICKER {
        return Err(bad("O sticker deve ter até 2 MB"));
    }
    let mime = crate::social::sniff_image(&body).ok_or_else(|| bad("Use uma imagem PNG, JPEG, WebP ou GIF"))?;
    let hash = fingerprint(&body);
    let existing = app
        .db
        .query_one(
            "SELECT id, name, mime FROM stickers WHERE owner_id = ?1 AND hash = ?2",
            [me.id.as_str(), hash.as_str()],
            |r| Ok(sticker(r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .await?;
    if let Some(s) = existing {
        return Ok((StatusCode::OK, Json(s)));
    }
    let count = app
        .db
        .query_one("SELECT COUNT(*) FROM stickers WHERE owner_id = ?1", [me.id.as_str()], |r| r.get::<i64>(0))
        .await?
        .unwrap_or(0);
    if count >= MAX_PER_USER {
        return Err(bad("Limite de 200 stickers: apague alguns para adicionar outros"));
    }
    let name: String = q.name.trim().chars().take(40).collect();
    let name = if name.is_empty() { "Sticker".to_string() } else { name };
    let id = uuid::Uuid::new_v4().simple().to_string();
    app.db
        .execute(
            "INSERT INTO stickers (id, owner_id, name, mime, data, hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            libsql::params![id.as_str(), me.id.as_str(), name.as_str(), mime, body.to_vec(), hash, crate::now_ms()],
        )
        .await?;
    Ok((StatusCode::CREATED, Json(sticker(id, name, mime.to_string()))))
}

async fn remove(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    app.db
        .execute("DELETE FROM stickers WHERE id = ?1 AND owner_id = ?2", [id.as_str(), me.id.as_str()])
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A imagem continua acessível depois de apagada da coleção? Não: some, e a mensagem mostra
/// "sticker indisponível". Por isso a coleção só apaga o que é da pessoa.
async fn image(State(app): AppState, Path(id): Path<String>) -> Response {
    let row = app
        .db
        .query_one("SELECT mime, data FROM stickers WHERE id = ?1", [id.as_str()], |r| {
            Ok((r.get::<String>(0)?, r.get::<Vec<u8>>(1)?))
        })
        .await;
    match row {
        Ok(Some((mime, data))) => {
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=31536000, immutable".into())], data)
                .into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mesma_imagem_mesma_impressao() {
        let a = super::fingerprint(b"GIF89a-um-gif");
        assert_eq!(a, super::fingerprint(b"GIF89a-um-gif"));
        assert_ne!(a, super::fingerprint(b"GIF89a-outro-gif"));
    }
}
