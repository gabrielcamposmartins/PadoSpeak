//! API REST: autenticação, servidores (guilds), canais e histórico de mensagens.
use crate::auth;
use crate::host::App;
use crate::models::*;
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, State};
use axum::http::{request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

const COLORS: [&str; 10] = [
    "#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245", "#3ba55c", "#faa61a", "#9b59b6", "#1abc9c", "#e67e22",
];

fn random_color() -> String {
    COLORS[uuid::Uuid::new_v4().as_bytes()[0] as usize % COLORS.len()].to_string()
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn invite_code() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..10].to_string()
}

// ---------- Erros ----------

pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self(status, msg.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<libsql::Error> for ApiError {
    fn from(e: libsql::Error) -> Self {
        eprintln!("erro de banco: {e}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno")
    }
}

fn bad(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}
fn not_found(msg: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, msg)
}
fn forbidden(msg: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, msg)
}

// ---------- Extrator de usuário autenticado ----------

pub struct AuthUser(pub User, pub String);

impl FromRequestParts<Arc<App>> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_string();
        match auth::user_from_token(&app.db, &token).await {
            Some(user) => Ok(AuthUser(user, token)),
            None => Err(ApiError::new(StatusCode::UNAUTHORIZED, "Não autenticado")),
        }
    }
}

// ---------- Consultas compartilhadas (também usadas pelo hub) ----------

pub async fn is_member(app: &App, guild_id: &str, user_id: &str) -> ApiResult<bool> {
    Ok(app
        .db
        .query_one("SELECT 1 FROM guild_members WHERE guild_id = ?1 AND user_id = ?2", [guild_id, user_id], |_| Ok(()))
        .await?
        .is_some())
}

pub async fn channel_with_access(app: &App, channel_id: &str, user_id: &str) -> Option<Channel> {
    let sql = format!(
        "SELECT {CHANNEL_COLS} FROM channels c \
         JOIN guild_members m ON m.guild_id = c.guild_id AND m.user_id = ?1 WHERE c.id = ?2"
    );
    app.db.query_one(&sql, [user_id, channel_id], channel_from_row).await.ok().flatten()
}

pub async fn guild_ids_of(app: &App, user_id: &str) -> Vec<String> {
    app.db
        .query_all("SELECT guild_id FROM guild_members WHERE user_id = ?1", [user_id], |r| r.get::<String>(0))
        .await
        .unwrap_or_default()
}

async fn guild_full(app: &App, guild_id: &str) -> ApiResult<Option<GuildFull>> {
    let sql = format!("SELECT {GUILD_COLS} FROM guilds g WHERE g.id = ?1");
    let Some(guild) = app.db.query_one(&sql, [guild_id], guild_from_row).await? else {
        return Ok(None);
    };
    let channels = app
        .db
        .query_all(
            &format!("SELECT {CHANNEL_COLS} FROM channels c WHERE c.guild_id = ?1 ORDER BY c.type, c.position, c.created_at"),
            [guild_id],
            channel_from_row,
        )
        .await?;
    let members = app
        .db
        .query_all(
            &format!(
                "SELECT {USER_COLS} FROM guild_members m JOIN users u ON u.id = m.user_id \
                 WHERE m.guild_id = ?1 ORDER BY u.display_name COLLATE NOCASE"
            ),
            [guild_id],
            user_from_row,
        )
        .await?;
    Ok(Some(GuildFull { guild, channels, members }))
}

// ---------- Rotas ----------

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/config", get(get_config))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/guilds", get(list_guilds).post(create_guild))
        .route("/api/guilds/join", post(join_guild))
        .route("/api/guilds/{id}", get(get_guild).delete(delete_guild))
        .route("/api/guilds/{id}/leave", post(leave_guild))
        .route("/api/guilds/{id}/channels", post(create_channel))
        .route("/api/channels/{id}", delete(delete_channel))
        .route("/api/channels/{id}/messages", get(list_messages))
}

async fn get_config(State(app): AppState) -> Json<Value> {
    Json(json!({
        "serverName": app.config.server_name,
        "iceServers": app.config.ice_servers,
        "allowRegistration": app.config.allow_registration,
        // Nó local do app desktop (perfil local + rede local), e não um servidor de comunidade.
        "localNode": app.lan.is_some(),
        "nodeId": app.lan.as_ref().map(|l| l.node_id.clone()),
        // Endereços na rede (sem localhost), usados para montar links de convite.
        "addresses": app.urls.iter().filter(|u| !u.contains("://localhost")).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// No nó local, criar perfil e entrar só valem a partir do próprio PC.
fn local_only(app: &App, addr: SocketAddr) -> ApiResult<()> {
    if app.lan.is_some() && !addr.ip().to_canonical().is_loopback() {
        return Err(forbidden("Este é o perfil local de outro PC: entre pelo PadoSpeak dele"));
    }
    Ok(())
}

async fn register(
    State(app): AppState,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<Credentials>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    local_only(&app, addr)?;
    if !app.config.allow_registration {
        return Err(forbidden("Cadastro desativado neste servidor"));
    }
    let username = body.username.trim().to_string();
    let valid = (3..=24).contains(&username.len())
        && username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if !valid {
        return Err(bad("Usuário deve ter 3–24 caracteres (letras, números, _ ou .)"));
    }
    if body.password.chars().count() < 6 {
        return Err(bad("A senha deve ter pelo menos 6 caracteres"));
    }
    let taken = app.db.query_one("SELECT 1 FROM users WHERE username = ?1", [username.as_str()], |_| Ok(())).await?;
    if taken.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Nome de usuário já em uso"));
    }
    let display_name: String = body
        .display_name
        .map(|d| d.trim().chars().take(32).collect::<String>())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| username.clone());
    let user = User { id: new_id(), username, display_name, avatar_color: random_color(), avatar_url: None, bio: String::new(), name_color: None, bio_color: None, lan: false };
    let hash = auth::hash_password(body.password).await;
    app.db
        .execute(
            "INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            libsql::params![user.id.as_str(), user.username.as_str(), user.display_name.as_str(), hash, user.avatar_color.as_str(), crate::now_ms()],
        )
        .await?;
    let token = auth::create_session(&app.db, &user.id).await?;
    Ok((StatusCode::CREATED, Json(json!({ "token": token, "user": user }))))
}

async fn login(
    State(app): AppState,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<Credentials>,
) -> ApiResult<Json<Value>> {
    local_only(&app, addr)?;
    let sql = format!("SELECT {USER_COLS}, u.password_hash FROM users u WHERE u.username = ?1");
    let found = app
        .db
        .query_one(&sql, [body.username.trim()], |r| Ok((user_from_row(r)?, r.get::<String>(USER_COLS_LEN)?)))
        .await?;
    let Some((user, hash)) = found else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Usuário ou senha incorretos"));
    };
    if !auth::verify_password(body.password, hash).await {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Usuário ou senha incorretos"));
    }
    let token = auth::create_session(&app.db, &user.id).await?;
    Ok(Json(json!({ "token": token, "user": user })))
}

async fn logout(State(app): AppState, AuthUser(_, token): AuthUser) -> ApiResult<StatusCode> {
    app.db.execute("DELETE FROM sessions WHERE token = ?1", [token]).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn me(AuthUser(user, _): AuthUser) -> Json<User> {
    Json(user)
}

async fn list_guilds(State(app): AppState, AuthUser(user, _): AuthUser) -> ApiResult<Json<Vec<Guild>>> {
    let sql = format!(
        "SELECT {GUILD_COLS} FROM guilds g JOIN guild_members m ON m.guild_id = g.id \
         WHERE m.user_id = ?1 ORDER BY m.joined_at"
    );
    Ok(Json(app.db.query_all(&sql, [user.id.as_str()], guild_from_row).await?))
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

async fn create_guild(
    State(app): AppState,
    AuthUser(user, _): AuthUser,
    Json(body): Json<NameBody>,
) -> ApiResult<(StatusCode, Json<GuildFull>)> {
    if app.lan.is_some() {
        return Err(forbidden("O perfil local não tem servidores: conecte-se a um servidor ou hospede o seu"));
    }
    let name: String = body.name.trim().chars().take(48).collect();
    if name.is_empty() {
        return Err(bad("Nome obrigatório"));
    }
    let id = new_id();
    let now = crate::now_ms();
    let conn = app.db.conn().await?;
    let tx = conn.transaction().await?;
    tx.execute(
        "INSERT INTO guilds (id, name, icon_color, owner_id, invite_code, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        libsql::params![id.as_str(), name, random_color(), user.id.as_str(), invite_code(), now],
    )
    .await?;
    tx.execute(
        "INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?1, ?2, ?3)",
        libsql::params![id.as_str(), user.id.as_str(), now],
    )
    .await?;
    for (name, kind) in [("geral", "text"), ("Geral", "voice")] {
        tx.execute(
            "INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
            libsql::params![new_id(), id.as_str(), name, kind, now],
        )
        .await?;
    }
    tx.commit().await?;
    app.hub.join_guild(&user.id, &id);
    let full = guild_full(&app, &id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?;
    Ok((StatusCode::CREATED, Json(full)))
}

#[derive(Deserialize)]
struct JoinBody {
    code: String,
}

async fn join_guild(
    State(app): AppState,
    AuthUser(user, _): AuthUser,
    Json(body): Json<JoinBody>,
) -> ApiResult<Json<GuildFull>> {
    if app.lan.is_some() {
        return Err(forbidden("O perfil local não tem servidores: conecte-se a um servidor para usar convites"));
    }
    let code = body.code.trim().rsplit('/').next().unwrap_or_default().to_string();
    let guild_id = app
        .db
        .query_one("SELECT id FROM guilds WHERE invite_code = ?1", [code], |r| r.get::<String>(0))
        .await?
        .ok_or_else(|| not_found("Convite inválido"))?;
    if !is_member(&app, &guild_id, &user.id).await? {
        app.db
            .execute(
                "INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES (?1, ?2, ?3)",
                libsql::params![guild_id.as_str(), user.id.as_str(), crate::now_ms()],
            )
            .await?;
        app.hub.join_guild(&user.id, &guild_id);
        app.hub.to_guild(&guild_id, "member:joined", json!({ "guildId": guild_id, "user": user }));
    }
    Ok(Json(guild_full(&app, &guild_id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?))
}

async fn get_guild(State(app): AppState, AuthUser(user, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<GuildFull>> {
    if !is_member(&app, &id, &user.id).await? {
        return Err(not_found("Servidor não encontrado"));
    }
    Ok(Json(guild_full(&app, &id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?))
}

async fn delete_guild(State(app): AppState, AuthUser(user, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let g = guild_full(&app, &id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?;
    if g.guild.owner_id != user.id {
        return Err(forbidden("Apenas o dono pode excluir o servidor"));
    }
    app.hub.to_guild(&id, "guild:deleted", json!({ "guildId": id }));
    app.hub.drop_guild(&id);
    // Exclusão explícita (não depende de ON DELETE CASCADE, que exige PRAGMA por conexão em modo remoto).
    let conn = app.db.conn().await?;
    let tx = conn.transaction().await?;
    tx.execute("DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?1)", [id.as_str()]).await?;
    tx.execute("DELETE FROM channels WHERE guild_id = ?1", [id.as_str()]).await?;
    tx.execute("DELETE FROM guild_members WHERE guild_id = ?1", [id.as_str()]).await?;
    tx.execute("DELETE FROM guilds WHERE id = ?1", [id.as_str()]).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn leave_guild(State(app): AppState, AuthUser(user, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let g = guild_full(&app, &id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?;
    if g.guild.owner_id == user.id {
        return Err(bad("O dono não pode sair; exclua o servidor"));
    }
    app.db
        .execute("DELETE FROM guild_members WHERE guild_id = ?1 AND user_id = ?2", [id.as_str(), user.id.as_str()])
        .await?;
    app.hub.leave_guild(&user.id, &id);
    app.hub.to_guild(&id, "member:left", json!({ "guildId": id, "userId": user.id }));
    Ok(StatusCode::NO_CONTENT)
}

async fn create_channel(
    State(app): AppState,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<NameBody>,
) -> ApiResult<(StatusCode, Json<Channel>)> {
    let g = guild_full(&app, &id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?;
    if g.guild.owner_id != user.id {
        return Err(forbidden("Apenas o dono pode criar canais"));
    }
    let kind = if body.kind.as_deref() == Some("voice") { "voice" } else { "text" };
    let mut name: String = body.name.trim().chars().take(32).collect();
    if kind == "text" {
        name = name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-");
    }
    if name.is_empty() {
        return Err(bad("Nome obrigatório"));
    }
    let channel = Channel {
        id: new_id(),
        guild_id: id.clone(),
        name,
        kind: kind.to_string(),
        position: g.channels.iter().filter(|c| c.kind == kind).count() as i64,
    };
    app.db
        .execute(
            "INSERT INTO channels (id, guild_id, name, type, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            libsql::params![channel.id.as_str(), id.as_str(), channel.name.as_str(), kind, channel.position, crate::now_ms()],
        )
        .await?;
    app.hub.to_guild(&id, "channel:created", &channel);
    Ok((StatusCode::CREATED, Json(channel)))
}

async fn delete_channel(State(app): AppState, AuthUser(user, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let ch = channel_with_access(&app, &id, &user.id).await.ok_or_else(|| not_found("Canal não encontrado"))?;
    let g = guild_full(&app, &ch.guild_id).await?.ok_or_else(|| not_found("Servidor não encontrado"))?;
    if g.guild.owner_id != user.id {
        return Err(forbidden("Apenas o dono pode excluir canais"));
    }
    app.hub.close_voice_channel(&ch.id);
    let conn = app.db.conn().await?;
    let tx = conn.transaction().await?;
    tx.execute("DELETE FROM messages WHERE channel_id = ?1", [id.as_str()]).await?;
    tx.execute("DELETE FROM channels WHERE id = ?1", [id.as_str()]).await?;
    tx.commit().await?;
    app.hub.to_guild(&ch.guild_id, "channel:deleted", json!({ "guildId": ch.guild_id, "channelId": ch.id }));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MessagesQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

async fn list_messages(
    State(app): AppState,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let before = q.before.unwrap_or(i64::MAX);
    let ch = channel_with_access(&app, &id, &user.id).await.filter(|c| c.kind == "text");
    let Some(ch) = ch else {
        // Conversa direta usa a mesma rota.
        let dm = crate::social::dm_with_access(&app, &id, &user.id).await.ok_or_else(|| not_found("Canal não encontrado"))?;
        return Ok(Json(crate::social::dm_messages(&app, &dm.id, before, limit).await?));
    };
    let sql = format!("{MESSAGE_SELECT} WHERE m.channel_id = ?1 AND m.created_at < ?2 ORDER BY m.created_at DESC LIMIT ?3");
    let mut list = app.db.query_all(&sql, libsql::params![ch.id.as_str(), before, limit], message_from_row).await?;
    list.reverse();
    Ok(Json(list))
}
