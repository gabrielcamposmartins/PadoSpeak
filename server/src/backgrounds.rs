//! Imagens de fundo: a da tela de início de cada pessoa e a de cada servidor. O app já manda a
//! imagem redimensionada (até 1920 px, WebP/JPEG); na tela ela cobre a janela toda (cortando as
//! sobras, sem faixas pretas).
use crate::api::{require_perm, ApiError, AuthUser};
use crate::host::App;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Até 3 MB (o app manda bem menos que isso).
const MAX_BACKGROUND: usize = 3 * 1024 * 1024;

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route(
            "/api/me/background",
            put(set_mine).delete(remove_mine).layer(DefaultBodyLimit::max(MAX_BACKGROUND + 64 * 1024)),
        )
        .route(
            "/api/guilds/{id}/background",
            put(set_guild).delete(remove_guild).layer(DefaultBodyLimit::max(MAX_BACKGROUND + 64 * 1024)),
        )
        .route("/api/backgrounds/{owner}", get(image))
}

fn bad(m: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, m.into())
}

async fn store(app: &App, owner: &str, body: &Bytes) -> ApiResult<()> {
    if body.is_empty() || body.len() > MAX_BACKGROUND {
        return Err(bad("A imagem de fundo deve ter até 3 MB"));
    }
    let mime = crate::social::sniff_image(body).ok_or_else(|| bad("Use uma imagem PNG, JPEG, WebP ou GIF"))?;
    app.db
        .execute(
            "INSERT INTO backgrounds (owner_id, mime, data) VALUES (?1, ?2, ?3) \
             ON CONFLICT(owner_id) DO UPDATE SET mime = excluded.mime, data = excluded.data",
            libsql::params![owner, mime, body.to_vec()],
        )
        .await?;
    Ok(())
}

/// Fundo da tela de início (só a própria pessoa usa).
pub async fn my_background_url(app: &App, user_id: &str) -> Option<String> {
    app.db
        .query_one("SELECT background_at FROM users WHERE id = ?1", [user_id], |r| r.get::<Option<i64>>(0))
        .await
        .ok()
        .flatten()
        .flatten()
        .map(|v| format!("/api/backgrounds/{user_id}?v={v}"))
}

async fn set_mine(State(app): AppState, AuthUser(me, _): AuthUser, body: Bytes) -> ApiResult<Json<Value>> {
    store(&app, &me.id, &body).await?;
    app.db.execute("UPDATE users SET background_at = ?1 WHERE id = ?2", libsql::params![crate::now_ms(), me.id.as_str()]).await?;
    let url = my_background_url(&app, &me.id).await;
    app.hub.to_user(&me.id, "me:background", json!({ "url": url }));
    Ok(Json(json!({ "url": url })))
}

async fn remove_mine(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    app.db.execute("DELETE FROM backgrounds WHERE owner_id = ?1", [me.id.as_str()]).await?;
    app.db.execute("UPDATE users SET background_at = NULL WHERE id = ?1", [me.id.as_str()]).await?;
    app.hub.to_user(&me.id, "me:background", json!({ "url": null }));
    Ok(Json(json!({ "url": null })))
}

async fn set_guild(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>, body: Bytes) -> ApiResult<Json<crate::models::Guild>> {
    require_perm(&app, &id, &me.id, crate::api::perm::ADMIN, "Apenas administradores mudam o fundo do servidor").await?;
    store(&app, &id, &body).await?;
    app.db.execute("UPDATE guilds SET background_at = ?1 WHERE id = ?2", libsql::params![crate::now_ms(), id.as_str()]).await?;
    app.audit(crate::audit::Entry::new(&id, "settings.background", &me.id).detail(json!({ "on": true })));
    Ok(Json(crate::api::announce_guild(&app, &id).await?))
}

async fn remove_guild(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<crate::models::Guild>> {
    require_perm(&app, &id, &me.id, crate::api::perm::ADMIN, "Apenas administradores mudam o fundo do servidor").await?;
    app.db.execute("DELETE FROM backgrounds WHERE owner_id = ?1", [id.as_str()]).await?;
    app.db.execute("UPDATE guilds SET background_at = NULL WHERE id = ?1", [id.as_str()]).await?;
    app.audit(crate::audit::Entry::new(&id, "settings.background", &me.id).detail(json!({ "on": false })));
    Ok(Json(crate::api::announce_guild(&app, &id).await?))
}

/// A imagem (pública como as fotos de perfil; o link com a versão só aparece para quem usa).
async fn image(State(app): AppState, Path(owner): Path<String>) -> Response {
    match app
        .db
        .query_one("SELECT mime, data FROM backgrounds WHERE owner_id = ?1", [owner.as_str()], |r| {
            Ok((r.get::<String>(0)?, r.get::<Vec<u8>>(1)?))
        })
        .await
    {
        Ok(Some((mime, data))) => {
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=31536000, immutable".into())], data).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
