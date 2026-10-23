//! Perfil (nome, bio e foto), amizades e conversas diretas (DMs).
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use crate::models::*;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Tamanho máximo da foto de perfil (o cliente já reduz para 256×256).
const MAX_AVATAR: usize = 1024 * 1024;
/// GIF/WebP animado vai como está (reduzir pararia a animação no primeiro quadro).
const MAX_AVATAR_ANIMATED: usize = 2 * 1024 * 1024;

fn bad(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}
fn not_found(msg: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, msg)
}

/// Par canônico (menor id primeiro), usado em amizades e DMs.
pub fn pair<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a < b { (a, b) } else { (b, a) }
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/me/profile", axum::routing::patch(update_profile))
        .route("/api/me/username", axum::routing::put(change_username))
        .route("/api/me/avatar", put(upload_avatar).delete(remove_avatar))
        .route("/api/users/{id}", get(profile))
        .route("/api/users/{id}/avatar", get(avatar))
        .route("/api/friends", get(list_friends).post(request_friend))
        .route("/api/friends/{id}", axum::routing::delete(remove_friend))
        .route("/api/friends/{id}/accept", post(accept_friend))
        .route("/api/dms", get(list_dms).post(open_dm))
        .route("/api/dms/{id}", axum::routing::delete(hide_dm))
        .route("/api/me/blocks/{id}", put(block_user).delete(unblock_user))
        .route("/api/me/hidden", get(list_hidden).post(hide_profile))
        .route("/api/me/hidden/{id}", axum::routing::delete(unhide_profile))
        .route("/api/me/settings", get(get_settings).patch(update_settings))
        .route("/api/me/nudge-blocks/{id}", put(block_nudges).delete(unblock_nudges))
        .route("/api/me/marks", get(list_marks))
        .route("/api/me/marks/{kind}/{id}", put(add_mark).delete(remove_mark))
}

// ---------- Marcas só para mim: "excluir para mim", "marcar como NSFW" e favoritar ----------

const MARK_KINDS: [&str; 3] = ["hidden", "nsfw", "star"];
/// Quantas marcas cada pessoa guarda (as mais antigas saem).
const MAX_MARKS: i64 = 20_000;

/// `{ hidden: [ids], nsfw: [ids], star: [ids] }` das minhas marcas.
async fn list_marks(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let rows = app
        .db
        .query_all("SELECT kind, message_id FROM message_marks WHERE user_id = ?1", [me.id.as_str()], |r| {
            Ok((r.get::<String>(0)?, r.get::<String>(1)?))
        })
        .await?;
    let mut out = json!({ "hidden": [], "nsfw": [], "star": [] });
    for (kind, id) in rows {
        if let Some(list) = out.get_mut(&kind).and_then(Value::as_array_mut) {
            list.push(Value::String(id));
        }
    }
    Ok(Json(out))
}

fn mark_params(kind: &str, id: &str) -> ApiResult<()> {
    if !MARK_KINDS.contains(&kind) {
        return Err(bad("Marca desconhecida"));
    }
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(bad("Mensagem inválida"));
    }
    Ok(())
}

/// Marca uma mensagem só para mim; os meus outros aparelhos ficam sabendo na hora.
async fn add_mark(State(app): AppState, AuthUser(me, _): AuthUser, Path((kind, id)): Path<(String, String)>) -> ApiResult<StatusCode> {
    mark_params(&kind, &id)?;
    app.db
        .execute(
            "INSERT OR IGNORE INTO message_marks (user_id, message_id, kind, created_at) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![me.id.as_str(), id.as_str(), kind.as_str(), crate::now_ms()],
        )
        .await?;
    app.db
        .execute(
            "DELETE FROM message_marks WHERE user_id = ?1 AND rowid NOT IN              (SELECT rowid FROM message_marks WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
            libsql::params![me.id.as_str(), MAX_MARKS],
        )
        .await?;
    app.hub.to_users(&[me.id.clone()], "mark:update", json!({ "kind": kind, "id": id, "on": true }));
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_mark(State(app): AppState, AuthUser(me, _): AuthUser, Path((kind, id)): Path<(String, String)>) -> ApiResult<StatusCode> {
    mark_params(&kind, &id)?;
    app.db
        .execute(
            "DELETE FROM message_marks WHERE user_id = ?1 AND message_id = ?2 AND kind = ?3",
            [me.id.as_str(), id.as_str(), kind.as_str()],
        )
        .await?;
    app.hub.to_users(&[me.id.clone()], "mark:update", json!({ "kind": kind, "id": id, "on": false }));
    Ok(StatusCode::NO_CONTENT)
}

async fn user_by_id(app: &App, id: &str) -> ApiResult<Option<User>> {
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    Ok(app.db.query_one(&sql, [id], user_from_row).await?)
}

/// Avisa todos os conectados (nome/foto aparecem em mensagens, membros, voz, amigos…).
pub(crate) async fn broadcast_user(app: &App, id: &str) -> ApiResult<User> {
    let user = user_by_id(app, id).await?.ok_or_else(|| not_found("Usuário não encontrado"))?;
    app.hub.to_all("user:updated", &user);
    Ok(user)
}

// ---------- Perfil ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileBody {
    display_name: Option<String>,
    bio: Option<String>,
    /// `#rrggbb`, ou "" para voltar à cor padrão.
    name_color: Option<String>,
    bio_color: Option<String>,
    banner_color: Option<String>,
    /// Cor padrão das mensagens.
    message_color: Option<String>,
}

async fn update_profile(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<ProfileBody>) -> ApiResult<Json<Value>> {
    if let Some(name) = body.display_name {
        let name = fit_formatted(&name, NAME_MAX, NAME_RAW_MAX)
            .ok_or_else(|| bad("O nome de exibição pode ter até 32 caracteres (e formatação de até 128)"))?;
        if visible_len(&name) == 0 {
            return Err(bad("O nome de exibição não pode ficar vazio"));
        }
        app.db.execute("UPDATE users SET display_name = ?1 WHERE id = ?2", [name.as_str(), me.id.as_str()]).await?;
    }
    if let Some(bio) = body.bio {
        let bio = fit_formatted(&bio, BIO_MAX, BIO_RAW_MAX)
            .ok_or_else(|| bad("O \"Sobre mim\" pode ter até 190 caracteres (e formatação de até 600)"))?;
        app.db.execute("UPDATE users SET bio = ?1 WHERE id = ?2", [bio.as_str(), me.id.as_str()]).await?;
    }
    for (col, value) in [
        ("name_color", body.name_color),
        ("bio_color", body.bio_color),
        ("banner_color", body.banner_color),
        ("message_color", body.message_color),
    ] {
        let Some(value) = value else { continue };
        let value = value.trim().to_string();
        if !value.is_empty() && !valid_color(&value) {
            return Err(bad("Cor inválida (use #rrggbb)"));
        }
        let value = (!value.is_empty()).then_some(value);
        app.db.execute(&format!("UPDATE users SET {col} = ?1 WHERE id = ?2"), libsql::params![value, me.id.as_str()]).await?;
    }
    let user = broadcast_user(&app, &me.id).await?;
    let bio = app.db.query_one("SELECT bio FROM users WHERE id = ?1", [me.id.as_str()], |r| r.get::<String>(0)).await?;
    Ok(Json(json!({ "user": user, "bio": bio.unwrap_or_default() })))
}

#[derive(Deserialize)]
struct UsernameBody {
    username: String,
}

/// Troca o @ (o nome de usuário). Não pode repetir o de ninguém (sem diferenciar maiúsculas); mudar só
/// maiúsculas e minúsculas do próprio pode. O @ do dono do app não muda (o painel do administrador é dele
/// por esse nome, e outra pessoa poderia pegar o nome livre).
async fn change_username(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<UsernameBody>) -> ApiResult<Json<User>> {
    let name = body.username.trim().trim_start_matches('@').to_string();
    crate::api::check_username(&name)?;
    if name == me.username {
        return Ok(Json(me));
    }
    let owner = crate::admin::owner_username();
    if app.lan.is_none() && (me.username.to_lowercase() == owner || name.to_lowercase() == owner) {
        return Err(ApiError(StatusCode::CONFLICT, if me.username.to_lowercase() == owner {
            "O @ do dono do app não pode mudar".into()
        } else {
            "Esse @ já é de outra pessoa".into()
        }));
    }
    let taken = app
        .db
        .query_one("SELECT id FROM users WHERE username = ?1 AND id != ?2", [name.as_str(), me.id.as_str()], |r| r.get::<String>(0))
        .await?;
    if taken.is_some() {
        return Err(ApiError(StatusCode::CONFLICT, "Esse @ já é de outra pessoa".into()));
    }
    // A coluna é UNIQUE (sem diferenciar maiúsculas): se duas pessoas pedirem o mesmo @ ao mesmo tempo, só uma leva.
    app.db
        .execute("UPDATE users SET username = ?1 WHERE id = ?2", [name.as_str(), me.id.as_str()])
        .await
        .map_err(|_| ApiError(StatusCode::CONFLICT, "Esse @ já é de outra pessoa".into()))?;
    Ok(Json(broadcast_user(&app, &me.id).await?))
}

/// Confere o tipo pelo conteúdo (não confia só no cabeçalho).
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

async fn upload_avatar(State(app): AppState, AuthUser(me, _): AuthUser, body: Bytes) -> ApiResult<Json<User>> {
    let mime = sniff_image(&body).ok_or_else(|| bad("Use uma imagem PNG, JPEG, WebP ou GIF"))?;
    let animated = matches!(mime, "image/gif" | "image/webp");
    if body.len() > if animated { MAX_AVATAR_ANIMATED } else { MAX_AVATAR } {
        return Err(bad(if animated { "A foto animada deve ter até 2 MB" } else { "A imagem deve ter até 1 MB" }));
    }
    let conn = app.db.conn().await?;
    let tx = conn.transaction().await?;
    tx.execute(
        "INSERT INTO avatars (user_id, mime, data) VALUES (?1, ?2, ?3) \
         ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data",
        libsql::params![me.id.as_str(), mime, body.to_vec()],
    )
    .await?;
    tx.execute("UPDATE users SET avatar_at = ?1 WHERE id = ?2", libsql::params![crate::now_ms(), me.id.as_str()]).await?;
    tx.commit().await?;
    Ok(Json(broadcast_user(&app, &me.id).await?))
}

async fn remove_avatar(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<User>> {
    app.db.execute("DELETE FROM avatars WHERE user_id = ?1", [me.id.as_str()]).await?;
    app.db.execute("UPDATE users SET avatar_at = NULL WHERE id = ?1", [me.id.as_str()]).await?;
    Ok(Json(broadcast_user(&app, &me.id).await?))
}

#[derive(Deserialize, Default)]
struct AvatarQuery {
    #[serde(default)]
    token: String,
}

// ---------- Esconder meu perfil de (veja `crate::privacy`) ----------

async fn hidden_list(app: &App, owner: &str) -> ApiResult<Vec<User>> {
    let sql = format!(
        "SELECT {USER_COLS} FROM profile_hidden h JOIN users u ON u.id = h.viewer_id \
         WHERE h.owner_id = ?1 ORDER BY h.created_at DESC"
    );
    Ok(app.db.query_all(&sql, [owner], user_from_row).await?)
}

async fn list_hidden(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Vec<User>>> {
    Ok(Json(hidden_list(&app, &me.id).await?))
}

#[derive(Deserialize)]
struct HideBody {
    /// Usuário (com ou sem @) de quem não vai ver a foto, a mensagem pessoal e o banner.
    username: String,
}

/// A pessoa recebe o meu perfil de novo, já como deve ver (a escrita do WebSocket mascara se for o caso).
async fn resend_profile(app: &App, owner: &str, viewer: &str) {
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    if let Ok(Some(user)) = app.db.query_one(&sql, [owner], user_from_row).await {
        app.hub.to_user(viewer, "user:updated", &user);
    }
}

async fn hide_profile(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<HideBody>) -> ApiResult<Json<Vec<User>>> {
    let name = body.username.trim().trim_start_matches('@').to_lowercase();
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE lower(u.username) = ?1");
    let other = app
        .db
        .query_one(&sql, [name.as_str()], user_from_row)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Ninguém com esse usuário"))?;
    if other.id == me.id {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Você não pode esconder o perfil de você mesmo"));
    }
    app.db
        .execute(
            "INSERT OR IGNORE INTO profile_hidden (owner_id, viewer_id, created_at) VALUES (?1, ?2, ?3)",
            libsql::params![me.id.as_str(), other.id.as_str(), crate::now_ms()],
        )
        .await?;
    app.privacy.set(&me.id, &other.id, true);
    resend_profile(&app, &me.id, &other.id).await;
    Ok(Json(hidden_list(&app, &me.id).await?))
}

async fn unhide_profile(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<User>>> {
    app.db.execute("DELETE FROM profile_hidden WHERE owner_id = ?1 AND viewer_id = ?2", [me.id.as_str(), id.as_str()]).await?;
    app.privacy.set(&me.id, &id, false);
    resend_profile(&app, &me.id, &id).await;
    Ok(Json(hidden_list(&app, &me.id).await?))
}

/// Foto (a URL leva a versão, então pode ficar em cache). Quem usa "esconder meu perfil de" só mostra a
/// foto para quem fez login (token na URL, já que o `<img>` não manda cabeçalho) e não está na lista.
async fn avatar(State(app): AppState, Path(id): Path<String>, Query(q): Query<AvatarQuery>, headers: HeaderMap) -> Response {
    let guarded = app.privacy.has_list(&id);
    if guarded {
        let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
        let viewer = crate::auth::user_from_token(&app.db, bearer.unwrap_or(&q.token)).await;
        if viewer.is_none_or(|v| app.privacy.hides(&id, &v.id)) {
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    let row = app
        .db
        .query_one("SELECT mime, data FROM avatars WHERE user_id = ?1", [id.as_str()], |r| {
            Ok((r.get::<String>(0)?, r.get::<Vec<u8>>(1)?))
        })
        .await;
    match row {
        Ok(Some((mime, data))) => {
            let cache = if guarded { "private, no-cache" } else { "public, max-age=31536000, immutable" };
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.into())], data).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    user: User,
    bio: String,
    created_at: i64,
    friend_status: Option<&'static str>,
    mutual_guilds: Vec<String>,
    online: bool,
}

async fn profile(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Profile>> {
    let sql = format!("SELECT {USER_COLS}, u.bio, u.created_at FROM users u WHERE u.id = ?1");
    let (user, bio, created_at) = app
        .db
        .query_one(&sql, [id.as_str()], |r| {
            Ok((user_from_row(r)?, r.get::<String>(USER_COLS_LEN)?, r.get::<i64>(USER_COLS_LEN + 1)?))
        })
        .await?
        .ok_or_else(|| not_found("Usuário não encontrado"))?;
    let mutual_guilds = app
        .db
        .query_all(
            "SELECT g.name FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id \
             JOIN guilds g ON g.id = a.guild_id WHERE a.user_id = ?1 AND b.user_id = ?2 ORDER BY g.name",
            [me.id.as_str(), id.as_str()],
            |r| r.get::<String>(0),
        )
        .await?;
    let friend_status = if id == me.id { None } else { friend_status(&app, &me.id, &id).await? };
    Ok(Json(Profile { online: app.hub.is_online(&user.id), user, bio, created_at, friend_status, mutual_guilds }))
}

// ---------- Amizades ----------

/// `friend` | `incoming` (pediram para mim) | `outgoing` (eu pedi) | None
pub async fn friend_status(app: &App, me: &str, other: &str) -> ApiResult<Option<&'static str>> {
    let (a, b) = pair(me, other);
    let row = app
        .db
        .query_one("SELECT status, requester_id FROM friendships WHERE user_a = ?1 AND user_b = ?2", [a, b], |r| {
            Ok((r.get::<String>(0)?, r.get::<String>(1)?))
        })
        .await?;
    Ok(row.map(|(status, requester)| match (status.as_str(), requester == me) {
        ("accepted", _) => "friend",
        (_, true) => "outgoing",
        _ => "incoming",
    }))
}

pub async fn friend_ids(app: &App, user_id: &str) -> Vec<String> {
    app.db
        .query_all(
            "SELECT CASE WHEN user_a = ?1 THEN user_b ELSE user_a END FROM friendships \
             WHERE (user_a = ?1 OR user_b = ?1) AND status = 'accepted'",
            [user_id],
            |r| r.get::<String>(0),
        )
        .await
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FriendEntry {
    user: User,
    status: &'static str,
    online: bool,
    /// Status escolhido (online, away, busy) quando visível.
    presence: Option<String>,
}

async fn list_friends(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Vec<FriendEntry>>> {
    let sql = format!(
        "SELECT {USER_COLS}, f.status, f.requester_id FROM friendships f \
         JOIN users u ON u.id = CASE WHEN f.user_a = ?1 THEN f.user_b ELSE f.user_a END \
         WHERE f.user_a = ?1 OR f.user_b = ?1 ORDER BY u.display_name COLLATE NOCASE"
    );
    let rows = app
        .db
        .query_all(&sql, [me.id.as_str()], |r| {
            Ok((user_from_row(r)?, r.get::<String>(USER_COLS_LEN)?, r.get::<String>(USER_COLS_LEN + 1)?))
        })
        .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(user, status, requester)| FriendEntry {
                online: app.hub.is_online(&user.id),
                presence: app.hub.presence_of(&user.id),
                status: match (status.as_str(), requester == me.id) {
                    ("accepted", _) => "friend",
                    (_, true) => "outgoing",
                    _ => "incoming",
                },
                user,
            })
            .collect(),
    ))
}

/// Envia a cada lado a visão dele da amizade (status relativo + se o outro está online).
async fn notify_friendship(app: &App, a: &User, b: &User) -> ApiResult<()> {
    for (me, other) in [(a, b), (b, a)] {
        let status = friend_status(app, &me.id, &other.id).await?;
        app.hub.to_user(
            &me.id,
            "friend:update",
            json!({ "user": other, "status": status, "online": app.hub.is_online(&other.id), "presence": app.hub.presence_of(&other.id) }),
        );
    }
    app.hub.set_friends(&a.id, &b.id, friend_status(app, &a.id, &b.id).await? == Some("friend"));
    Ok(())
}

#[derive(Deserialize)]
struct FriendRequest {
    username: String,
}

async fn request_friend(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<FriendRequest>) -> ApiResult<Json<Value>> {
    let username = body.username.trim().trim_start_matches('@');
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.username = ?1");
    let other = app
        .db
        .query_one(&sql, [username], user_from_row)
        .await?
        .ok_or_else(|| not_found("Nenhum usuário com esse nome. Confira maiúsculas, acentos e o @."))?;
    if other.id == me.id {
        return Err(bad("Você não pode adicionar a si mesmo"));
    }
    match block_between(&app, &me.id, &other.id).await? {
        Some(true) => return Err(bad("Você bloqueou essa pessoa. Desbloqueie para mandar um pedido de amizade.")),
        Some(false) => return Err(ApiError::new(StatusCode::FORBIDDEN, "Não foi possível mandar o pedido de amizade")),
        None => {}
    }
    let status = match friend_status(&app, &me.id, &other.id).await? {
        Some("friend") => return Err(bad("Vocês já são amigos")),
        Some("outgoing") => return Err(bad("Pedido de amizade já enviado")),
        // A outra pessoa já tinha pedido: aceitar.
        Some(_) => {
            let (a, b) = pair(&me.id, &other.id);
            app.db.execute("UPDATE friendships SET status = 'accepted' WHERE user_a = ?1 AND user_b = ?2", [a, b]).await?;
            "friend"
        }
        None => {
            let (a, b) = pair(&me.id, &other.id);
            app.db
                .execute(
                    "INSERT INTO friendships (user_a, user_b, status, requester_id, created_at) VALUES (?1, ?2, 'pending', ?3, ?4)",
                    libsql::params![a, b, me.id.as_str(), crate::now_ms()],
                )
                .await?;
            "outgoing"
        }
    };
    notify_friendship(&app, &me, &other).await?;
    if status == "outgoing" {
        app.push_to(
            &other.id,
            crate::push::Note {
                title: "PadoSpeak".into(),
                body: format!("{} quer ser seu amigo.", plain_text(&me.display_name)),
                tag: format!("friend:{}", me.id),
                url: "/?friends=pending".into(),
                kind: "friend",
                from: crate::push::Sender::of(&me),
            },
        );
    }
    Ok(Json(json!({ "user": other, "status": status })))
}

async fn accept_friend(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if friend_status(&app, &me.id, &id).await? != Some("incoming") {
        return Err(bad("Não há pedido de amizade dessa pessoa"));
    }
    let (a, b) = pair(&me.id, &id);
    app.db.execute("UPDATE friendships SET status = 'accepted' WHERE user_a = ?1 AND user_b = ?2", [a, b]).await?;
    let other = user_by_id(&app, &id).await?.ok_or_else(|| not_found("Usuário não encontrado"))?;
    notify_friendship(&app, &me, &other).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Desfaz amizade, recusa ou cancela um pedido.
async fn remove_friend(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (a, b) = pair(&me.id, &id);
    app.db.execute("DELETE FROM friendships WHERE user_a = ?1 AND user_b = ?2", [a, b]).await?;
    if let Some(other) = user_by_id(&app, &id).await? {
        notify_friendship(&app, &me, &other).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------- Conversas diretas ----------

#[derive(Clone, Debug)]
pub struct DmChannel {
    pub id: String,
    pub user_a: String,
    pub user_b: String,
}

impl DmChannel {
    pub fn other(&self, me: &str) -> &str {
        if self.user_a == me { &self.user_b } else { &self.user_a }
    }
    pub fn users(&self) -> [String; 2] {
        [self.user_a.clone(), self.user_b.clone()]
    }
}

pub async fn dm_with_access(app: &App, dm_id: &str, user_id: &str) -> Option<DmChannel> {
    app.db
        .query_one(
            "SELECT id, user_a, user_b FROM dm_channels WHERE id = ?1 AND (user_a = ?2 OR user_b = ?2)",
            [dm_id, user_id],
            |r| Ok(DmChannel { id: r.get(0)?, user_a: r.get(1)?, user_b: r.get(2)? }),
        )
        .await
        .ok()
        .flatten()
}

/// Conversa direta pelo id, sem conferir quem pede (avisos do próprio servidor).
pub async fn dm_by_id(app: &App, dm_id: &str) -> Option<DmChannel> {
    app.db
        .query_one("SELECT id, user_a, user_b FROM dm_channels WHERE id = ?1", [dm_id], |r| {
            Ok(DmChannel { id: r.get(0)?, user_a: r.get(1)?, user_b: r.get(2)? })
        })
        .await
        .ok()
        .flatten()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub recipient: User,
    pub last_message_at: i64,
}

pub async fn dm_entry(app: &App, dm_id: &str, me: &str) -> ApiResult<Option<DmEntry>> {
    let sql = format!(
        "SELECT d.id, d.last_message_at, {USER_COLS} FROM dm_channels d \
         JOIN users u ON u.id = CASE WHEN d.user_a = ?2 THEN d.user_b ELSE d.user_a END \
         WHERE d.id = ?1 AND (d.user_a = ?2 OR d.user_b = ?2)"
    );
    Ok(app
        .db
        .query_one(&sql, [dm_id, me], |r| {
            Ok(DmEntry { id: r.get(0)?, kind: "dm", last_message_at: r.get(1)?, recipient: user_at(r, 2)? })
        })
        .await?)
}

async fn list_dms(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Vec<DmEntry>>> {
    let sql = format!(
        "SELECT d.id, d.last_message_at, {USER_COLS} FROM dm_channels d \
         JOIN users u ON u.id = CASE WHEN d.user_a = ?1 THEN d.user_b ELSE d.user_a END \
         LEFT JOIN dm_hidden h ON h.dm_id = d.id AND h.user_id = ?1 \
         WHERE (d.user_a = ?1 OR d.user_b = ?1) AND (h.hidden_at IS NULL OR d.last_message_at > h.hidden_at) \
         ORDER BY d.last_message_at DESC"
    );
    Ok(Json(
        app.db
            .query_all(&sql, [me.id.as_str()], |r| {
                Ok(DmEntry { id: r.get(0)?, kind: "dm", last_message_at: r.get(1)?, recipient: user_at(r, 2)? })
            })
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenDm {
    user_id: String,
}

/// Abre (ou reaproveita) a conversa com alguém que é amigo ou divide um servidor com você.
async fn open_dm(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<OpenDm>) -> ApiResult<Json<DmEntry>> {
    if body.user_id == me.id {
        return Err(bad("Não dá para conversar consigo mesmo"));
    }
    let shares_guild = app
        .db
        .query_one(
            "SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id WHERE a.user_id = ?1 AND b.user_id = ?2",
            [me.id.as_str(), body.user_id.as_str()],
            |_| Ok(()),
        )
        .await?
        .is_some();
    // No nó local, o perfil deste PC conversa com os perfis da rede (e só eles entre si, não).
    let lan_pair = app.lan.is_some() && {
        let other_lan = app
            .db
            .query_one("SELECT origin FROM users WHERE id = ?1", [body.user_id.as_str()], |r| r.get::<String>(0))
            .await?
            .is_some_and(|o| o == "lan");
        me.lan != other_lan
    };
    if app.lan.is_some() && !lan_pair {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "No perfil local só dá para conversar com perfis da rede"));
    }
    if !lan_pair && !shares_guild && friend_status(&app, &me.id, &body.user_id).await? != Some("friend") {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Vocês precisam ser amigos ou estar no mesmo servidor"));
    }
    let (a, b) = pair(&me.id, &body.user_id);
    let now = crate::now_ms();
    app.db
        .execute(
            "INSERT INTO dm_channels (id, user_a, user_b, created_at, last_message_at) VALUES (?1, ?2, ?3, ?4, ?4) \
             ON CONFLICT(user_a, user_b) DO NOTHING",
            libsql::params![uuid::Uuid::new_v4().to_string(), a, b, now],
        )
        .await?;
    let id = app
        .db
        .query_one("SELECT id FROM dm_channels WHERE user_a = ?1 AND user_b = ?2", [a, b], |r| r.get::<String>(0))
        .await?
        .ok_or_else(|| not_found("Conversa não encontrada"))?;
    // Abrir de novo traz de volta uma conversa tirada da lista.
    app.db.execute("DELETE FROM dm_hidden WHERE user_id = ?1 AND dm_id = ?2", [me.id.as_str(), id.as_str()]).await?;
    Ok(Json(dm_entry(&app, &id, &me.id).await?.ok_or_else(|| not_found("Conversa não encontrada"))?))
}

/// Tira a conversa da minha lista (o histórico continua). Volta ao abrir de novo ou com mensagem nova.
async fn hide_dm(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    dm_with_access(&app, &id, &me.id).await.ok_or_else(|| not_found("Conversa não encontrada"))?;
    app.db
        .execute(
            "INSERT INTO dm_hidden (user_id, dm_id, hidden_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(user_id, dm_id) DO UPDATE SET hidden_at = excluded.hidden_at",
            libsql::params![me.id.as_str(), id.as_str(), crate::now_ms()],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Histórico de uma DM (chamado pela rota de mensagens quando o id não é de um canal de servidor).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn par_canonico() {
        assert_eq!(pair("b", "a"), ("a", "b"));
        assert_eq!(pair("a", "b"), ("a", "b"));
    }

    #[test]
    fn detecta_imagem_pelo_conteudo() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff_image(b"<svg onload=alert(1)>"), None);
    }
}

// ---------- Configurações: chamar atenção ----------

/// `to` aceita "chamar atenção" de `from`? (ligado nas configurações e `from` fora da lista de bloqueio)
pub async fn accepts_nudge(app: &App, to: &str, from: &str) -> bool {
    let allowed = app
        .db
        .query_one("SELECT allow_nudges FROM users WHERE id = ?1", [to], |r| r.get::<i64>(0))
        .await
        .ok()
        .flatten()
        .unwrap_or(1)
        != 0;
    if !allowed {
        return false;
    }
    let blocked = app
        .db
        .query_one("SELECT 1 FROM nudge_blocks WHERE user_id = ?1 AND blocked_id = ?2", [to, from], |r| r.get::<i64>(0))
        .await
        .ok()
        .flatten();
    blocked.is_none()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    allow_nudges: bool,
    nudge_blocks: Vec<User>,
    /// Imagem de fundo da tela de início.
    background_url: Option<String>,
    /// Avisar os amigos quando fico online pelo computador / pelo celular.
    online_notify_desktop: bool,
    online_notify_phone: bool,
    /// Pessoas que eu bloqueei.
    blocks: Vec<User>,
}

async fn load_settings(app: &App, user_id: &str) -> ApiResult<Settings> {
    let (allow, online) = app
        .db
        .query_one("SELECT allow_nudges, online_notify FROM users WHERE id = ?1", [user_id], |r| Ok((r.get::<i64>(0)?, r.get::<i64>(1)?)))
        .await?
        .unwrap_or((1, crate::hub::ONLINE_NOTIFY_DEFAULT));
    let sql = format!(
        "SELECT {USER_COLS} FROM nudge_blocks b JOIN users u ON u.id = b.blocked_id \
         WHERE b.user_id = ?1 ORDER BY u.display_name COLLATE NOCASE"
    );
    let nudge_blocks = app.db.query_all(&sql, [user_id], user_from_row).await?;
    let sql = format!(
        "SELECT {USER_COLS} FROM user_blocks b JOIN users u ON u.id = b.blocked_id \
         WHERE b.user_id = ?1 ORDER BY u.display_name COLLATE NOCASE"
    );
    let blocks = app.db.query_all(&sql, [user_id], user_from_row).await?;
    Ok(Settings {
        allow_nudges: allow != 0,
        nudge_blocks,
        blocks,
        background_url: crate::backgrounds::my_background_url(app, user_id).await,
        online_notify_desktop: online & crate::hub::ONLINE_NOTIFY_DESKTOP != 0,
        online_notify_phone: online & crate::hub::ONLINE_NOTIFY_PHONE != 0,
    })
}

/// Algum dos dois bloqueou o outro? `Some(true)`: fui eu que bloqueei.
pub async fn block_between(app: &App, me: &str, other: &str) -> ApiResult<Option<bool>> {
    let mine = app
        .db
        .query_one("SELECT user_id FROM user_blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1)", [me, other], |r| {
            r.get::<String>(0)
        })
        .await?;
    Ok(mine.map(|by| by == me))
}

/// Bloqueia alguém: desfaz a amizade (ou o pedido) e impede novos pedidos dos dois lados.
async fn block_user(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Settings>> {
    if id == me.id {
        return Err(bad("Você não pode bloquear a si mesmo"));
    }
    let other = user_by_id(&app, &id).await?.ok_or_else(|| not_found("Usuário não encontrado"))?;
    app.db
        .execute(
            "INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?1, ?2, ?3)",
            libsql::params![me.id.as_str(), id.as_str(), crate::now_ms()],
        )
        .await?;
    let (a, b) = pair(&me.id, &id);
    app.db.execute("DELETE FROM friendships WHERE user_a = ?1 AND user_b = ?2", [a, b]).await?;
    notify_friendship(&app, &me, &other).await?;
    Ok(Json(load_settings(&app, &me.id).await?))
}

async fn unblock_user(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Settings>> {
    app.db.execute("DELETE FROM user_blocks WHERE user_id = ?1 AND blocked_id = ?2", [me.id.as_str(), id.as_str()]).await?;
    Ok(Json(load_settings(&app, &me.id).await?))
}

async fn get_settings(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Settings>> {
    Ok(Json(load_settings(&app, &me.id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsBody {
    allow_nudges: Option<bool>,
    online_notify_desktop: Option<bool>,
    online_notify_phone: Option<bool>,
}

async fn update_settings(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<SettingsBody>) -> ApiResult<Json<Settings>> {
    if let Some(allow) = body.allow_nudges {
        app.db
            .execute("UPDATE users SET allow_nudges = ?1 WHERE id = ?2", libsql::params![allow as i64, me.id.as_str()])
            .await?;
    }
    if body.online_notify_desktop.is_some() || body.online_notify_phone.is_some() {
        let cur = load_settings(&app, &me.id).await?;
        let bit = |on: bool, b: i64| if on { b } else { 0 };
        let bits = bit(body.online_notify_desktop.unwrap_or(cur.online_notify_desktop), crate::hub::ONLINE_NOTIFY_DESKTOP)
            | bit(body.online_notify_phone.unwrap_or(cur.online_notify_phone), crate::hub::ONLINE_NOTIFY_PHONE);
        app.db.execute("UPDATE users SET online_notify = ?1 WHERE id = ?2", libsql::params![bits, me.id.as_str()]).await?;
        app.hub.set_online_notify(&me.id, bits);
    }
    Ok(Json(load_settings(&app, &me.id).await?))
}

async fn block_nudges(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Settings>> {
    if id == me.id {
        return Err(bad("Você não pode bloquear a si mesmo"));
    }
    user_by_id(&app, &id).await?.ok_or_else(|| not_found("Usuário não encontrado"))?;
    app.db
        .execute("INSERT OR IGNORE INTO nudge_blocks (user_id, blocked_id) VALUES (?1, ?2)", [me.id.as_str(), id.as_str()])
        .await?;
    Ok(Json(load_settings(&app, &me.id).await?))
}

async fn unblock_nudges(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Settings>> {
    app.db
        .execute("DELETE FROM nudge_blocks WHERE user_id = ?1 AND blocked_id = ?2", [me.id.as_str(), id.as_str()])
        .await?;
    Ok(Json(load_settings(&app, &me.id).await?))
}
