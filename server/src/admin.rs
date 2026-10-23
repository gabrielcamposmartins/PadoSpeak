//! Painel do administrador do app (servidor de comunidade): todos os usuários e servidores, quanto
//! tempo cada pessoa ficou com o app aberto e em qual plataforma, e os dias/horários de mais uso.
//!
//! Só o dono do app (usuário `gabs`, ou o definido em `APP_OWNER`) vê, e ele pode liberar para
//! outras pessoas. No nó local do app desktop não existe. Dos servidores, o painel mostra também os
//! integrantes, as mensagens dos canais de texto e os arquivos (as conversas diretas ficam de fora).
//! O dono também escolhe as regras dos arquivos (tamanhos e validades, em `files::Policy`).
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use crate::models::{attach_reactions, message_from_row, open_message, user_from_row, Message, User, MESSAGE_SELECT, USER_COLS};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

const HOUR: i64 = 3600 * 1000;

/// Usuário dono do app (vê o painel e escolhe quem mais vê).
pub fn owner_username() -> String {
    std::env::var("APP_OWNER").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "gabs".into()).to_lowercase()
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/admin/access", get(access))
        .route("/api/admin/overview", get(overview))
        .route("/api/admin/guilds/{id}/members", get(guild_members))
        .route("/api/admin/guilds/{id}/channels", get(guild_channels))
        .route("/api/admin/guilds/{id}/files", get(guild_files))
        .route("/api/admin/channels/{id}/messages", get(channel_messages))
        .route("/api/admin/files", get(file_policy).put(save_file_policy))
        .route("/api/admin/viewers", get(viewers).put(grant))
        .route("/api/admin/viewers/{id}", delete(revoke))
}

/// (pode ver, é o dono)
async fn rights(app: &App, user: &User) -> ApiResult<(bool, bool)> {
    if app.lan.is_some() {
        return Ok((false, false));
    }
    let owner = user.username.to_lowercase() == owner_username();
    if owner {
        return Ok((true, true));
    }
    let granted = app.db.query_one("SELECT 1 FROM app_admins WHERE user_id = ?1", [user.id.as_str()], |_| Ok(())).await?.is_some();
    Ok((granted, false))
}

/// Pode ver o painel (e, com ele, as mensagens e os arquivos dos servidores).
pub async fn can_view(app: &App, user: &User) -> bool {
    rights(app, user).await.map(|(view, _)| view).unwrap_or(false)
}

async fn require_view(app: &App, user: &User) -> ApiResult<bool> {
    let (view, owner) = rights(app, user).await?;
    if !view {
        return Err(ApiError(StatusCode::NOT_FOUND, "Não encontrado".into()));
    }
    Ok(owner)
}

async fn access(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let (view, owner) = rights(&app, &me).await?;
    Ok(Json(json!({ "canView": view, "owner": owner })))
}

/// O app abriu numa conexão: começa a contar o tempo (devolve o id da sessão).
pub async fn start_session(app: &App, user_id: &str, platform: &str, device: &str, os: &str) -> Option<i64> {
    if app.lan.is_some() {
        return None;
    }
    let now = crate::now_ms();
    app.db
        .query_one(
            "INSERT INTO app_sessions (user_id, platform, device, os, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id",
            libsql::params![user_id, platform, device, os, now],
            |r| r.get::<i64>(0),
        )
        .await
        .ok()
        .flatten()
}

/// A sessão continua aberta (chamado a cada minuto e ao fechar).
pub async fn touch_session(app: &App, id: i64) {
    let _ = app.db.execute("UPDATE app_sessions SET ended_at = ?1 WHERE id = ?2", libsql::params![crate::now_ms(), id]).await;
}

#[derive(Deserialize)]
struct OverviewQuery {
    /// Período (dias) do tempo de uso e do gráfico.
    days: Option<i64>,
}

async fn overview(State(app): AppState, AuthUser(me, _): AuthUser, Query(q): Query<OverviewQuery>) -> ApiResult<Json<Value>> {
    require_view(&app, &me).await?;
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let now = crate::now_ms();
    let since = now - days * 24 * HOUR;

    // Sessões do período (cortadas no começo do período).
    let sessions = app
        .db
        .query_all(
            "SELECT user_id, platform, COALESCE(device, ''), COALESCE(os, ''), started_at, ended_at FROM app_sessions WHERE ended_at >= ?1",
            [since],
            |r| {
                Ok((
                    r.get::<String>(0)?,
                    r.get::<String>(1)?,
                    r.get::<String>(2)?,
                    r.get::<String>(3)?,
                    r.get::<i64>(4)?,
                    r.get::<i64>(5)?,
                ))
            },
        )
        .await?;

    // Por pessoa: tempo no período, por plataforma; por hora (UTC): quem estava e quantos minutos.
    let mut per_user: HashMap<String, (i64, i64, HashMap<String, i64>)> = HashMap::new(); // (ms, sessões, plataforma → ms)
    let mut per_platform: HashMap<(String, String), (i64, HashSet<String>)> = HashMap::new();
    let mut hours: HashMap<i64, (HashSet<String>, i64)> = HashMap::new();
    for (user, platform, device, os, start, end) in &sessions {
        let (start, end) = ((*start).max(since), (*end).min(now));
        if end <= start {
            continue;
        }
        let ms = end - start;
        let e = per_user.entry(user.clone()).or_default();
        e.0 += ms;
        e.1 += 1;
        let label = [platform.as_str(), device.as_str(), os.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
        *e.2.entry(label).or_default() += ms;
        let p = per_platform.entry((platform.clone(), device.clone())).or_default();
        p.0 += ms;
        p.1.insert(user.clone());
        let mut h = start - start.rem_euclid(HOUR);
        while h < end {
            let overlap = end.min(h + HOUR) - start.max(h);
            let slot = hours.entry(h).or_default();
            slot.0.insert(user.clone());
            slot.1 += overlap;
            h += HOUR;
        }
    }

    let sql = format!(
        "SELECT {USER_COLS}, u.created_at, (SELECT MAX(ended_at) FROM app_sessions s WHERE s.user_id = u.id), \
         (SELECT COALESCE(SUM(ended_at - started_at), 0) FROM app_sessions s WHERE s.user_id = u.id), \
         (SELECT COUNT(*) FROM guild_members m WHERE m.user_id = u.id) FROM users u WHERE COALESCE(u.origin, '') != 'lan' \
         ORDER BY u.created_at DESC"
    );
    let base = crate::models::USER_COLS_LEN;
    let users = app
        .db
        .query_all(&sql, (), |r| {
            Ok((user_from_row(r)?, r.get::<i64>(base)?, r.get::<Option<i64>>(base + 1)?, r.get::<i64>(base + 2)?, r.get::<i64>(base + 3)?))
        })
        .await?;
    let users: Vec<Value> = users
        .into_iter()
        .map(|(u, created, last_seen, total_ms, guilds)| {
            let (period_ms, sessions, platforms) = per_user.remove(&u.id).unwrap_or_default();
            let mut platforms: Vec<(String, i64)> = platforms.into_iter().collect();
            platforms.sort_by(|a, b| b.1.cmp(&a.1));
            json!({
                "user": u, "createdAt": created, "lastSeenAt": last_seen, "totalMs": total_ms, "periodMs": period_ms,
                "sessions": sessions, "guilds": guilds, "online": app.hub.is_online(&u.id),
                "platforms": platforms.into_iter().map(|(label, ms)| json!({ "label": label, "ms": ms })).collect::<Vec<_>>(),
            })
        })
        .collect();

    let guilds = app
        .db
        .query_all(
            "SELECT g.id, g.name, g.icon_color, g.icon_at, g.created_at, o.display_name, o.username, \
             (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id), \
             (SELECT COUNT(*) FROM channels c WHERE c.guild_id = g.id), \
             (SELECT COUNT(*) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.guild_id = g.id), \
             (SELECT MAX(x.created_at) FROM messages x JOIN channels c ON c.id = x.channel_id WHERE c.guild_id = g.id), \
             (SELECT COALESCE(SUM(COALESCE(f.stored, f.size)), 0) FROM files f WHERE f.guild_id = g.id) \
             FROM guilds g LEFT JOIN users o ON o.id = g.owner_id ORDER BY g.created_at DESC",
            (),
            |r| {
                let id: String = r.get(0)?;
                Ok(json!({
                    "iconUrl": r.get::<Option<i64>>(3)?.map(|v| format!("/api/guilds/{id}/icon?v={v}")),
                    "id": id, "name": r.get::<String>(1)?, "iconColor": r.get::<String>(2)?, "createdAt": r.get::<i64>(4)?,
                    "owner": crate::models::plain_text(&r.get::<Option<String>>(5)?.unwrap_or_default()),
                    "ownerUsername": r.get::<Option<String>>(6)?.unwrap_or_default(),
                    "members": r.get::<i64>(7)?, "channels": r.get::<i64>(8)?, "messages": r.get::<i64>(9)?,
                    "lastMessageAt": r.get::<Option<i64>>(10)?, "fileBytes": r.get::<i64>(11)?,
                }))
            },
        )
        .await?;

    let count = |sql: &'static str| {
        let app = app.clone();
        async move { app.db.query_one(sql, (), |r| r.get::<i64>(0)).await.ok().flatten().unwrap_or(0) }
    };
    let mut activity: Vec<Value> = hours
        .into_iter()
        .map(|(h, (users, ms))| json!({ "h": h, "users": users.len(), "minutes": ms / 60000 }))
        .collect();
    activity.sort_by_key(|v| v["h"].as_i64().unwrap_or(0));
    let mut platforms: Vec<Value> = per_platform
        .into_iter()
        .map(|((platform, device), (ms, users))| json!({ "platform": platform, "device": device, "ms": ms, "users": users.len() }))
        .collect();
    platforms.sort_by(|a, b| b["ms"].as_i64().cmp(&a["ms"].as_i64()));
    let stats = app.hub.stats();
    Ok(Json(json!({
        "days": days,
        "now": now,
        "totals": {
            "users": count("SELECT COUNT(*) FROM users WHERE COALESCE(origin, '') != 'lan'").await,
            "guilds": count("SELECT COUNT(*) FROM guilds").await,
            "messages": count("SELECT COUNT(*) FROM messages").await,
            "dmMessages": count("SELECT COUNT(*) FROM dm_messages").await,
            "onlineNow": stats.online_users,
            "connections": stats.connections,
            "inVoice": stats.voice_participants,
            "periodMs": sessions.iter().map(|s| (s.5.min(now) - s.4.max(since)).max(0)).sum::<i64>(),
        },
        "users": users,
        "guilds": guilds,
        "activity": activity,
        "platforms": platforms,
    })))
}

/// Integrantes de um servidor (aba Servidores do painel): quem é, desde quando, dono/admin e se está online.
async fn guild_members(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    require_view(&app, &me).await?;
    let sql = format!(
        "SELECT {USER_COLS}, m.joined_at, m.perms, g.owner_id FROM guild_members m          JOIN users u ON u.id = m.user_id JOIN guilds g ON g.id = m.guild_id          WHERE m.guild_id = ?1 ORDER BY m.joined_at"
    );
    let base = crate::models::USER_COLS_LEN;
    let rows = app
        .db
        .query_all(&sql, [id.as_str()], |r| {
            Ok((user_from_row(r)?, r.get::<i64>(base)?, r.get::<i64>(base + 1)?, r.get::<String>(base + 2)?))
        })
        .await?;
    let members: Vec<Value> = rows
        .into_iter()
        .map(|(u, joined, perms, owner)| {
            let role = if u.id == owner {
                Some("dono")
            } else if perms & crate::api::perm::ADMIN != 0 {
                Some("admin")
            } else {
                None
            };
            json!({ "user": u, "joinedAt": joined, "role": role, "online": app.hub.is_online(&u.id) })
        })
        .collect();
    Ok(Json(json!(members)))
}

/// Canais de texto de um servidor, com quantas mensagens cada um tem (os privados também).
async fn guild_channels(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    require_view(&app, &me).await?;
    let list = app
        .db
        .query_all(
            "SELECT c.id, c.name, c.private, (SELECT COUNT(*) FROM messages x WHERE x.channel_id = c.id),              (SELECT MAX(x.created_at) FROM messages x WHERE x.channel_id = c.id)              FROM channels c WHERE c.guild_id = ?1 AND c.type = 'text' ORDER BY c.position, c.name",
            [id.as_str()],
            |r| {
                Ok(json!({
                    "id": r.get::<String>(0)?, "name": r.get::<String>(1)?, "private": r.get::<i64>(2)? != 0,
                    "messages": r.get::<i64>(3)?, "lastMessageAt": r.get::<Option<i64>>(4)?,
                }))
            },
        )
        .await?;
    Ok(Json(Value::Array(list)))
}

#[derive(Deserialize)]
struct MessagesQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

/// Mensagens de um canal de texto de qualquer servidor (das mais novas para trás, como na conversa).
async fn channel_messages(
    State(app): AppState,
    AuthUser(me, _): AuthUser,
    Path(id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    require_view(&app, &me).await?;
    let text = app.db.query_one("SELECT 1 FROM channels WHERE id = ?1 AND type = 'text'", [id.as_str()], |_| Ok(())).await?;
    if text.is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "Canal não encontrado".into()));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let before = q.before.unwrap_or(i64::MAX);
    let sql = format!("{MESSAGE_SELECT} WHERE m.channel_id = ?1 AND m.created_at < ?2 ORDER BY m.created_at DESC LIMIT ?3");
    let mut list = app.db.query_all(&sql, libsql::params![id.as_str(), before, limit], message_from_row).await?;
    for m in &mut list {
        open_message(&app.db, m);
    }
    attach_reactions(&app.db, &mut list).await?;
    list.reverse();
    Ok(Json(list))
}

/// Arquivos de um servidor (os mesmos da tela de configuração dele).
async fn guild_files(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    require_view(&app, &me).await?;
    Ok(Json(crate::files::guild_file_list(&app, &id).await?))
}

/// Regras dos arquivos e como está o disco.
async fn file_policy(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let owner = require_view(&app, &me).await?;
    Ok(Json(json!({ "policy": crate::files::Policy::load(&app).await, "canEdit": owner, "usage": crate::files::usage(&app).await })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBody {
    policy: crate::files::Policy,
    /// Passa a validade padrão dos servidores para todos os que já existem.
    #[serde(default)]
    apply_to_guilds: bool,
}

/// Muda as regras dos arquivos (só o dono). A validade nova dos arquivos grandes vale também para
/// os que já estão no servidor.
async fn save_file_policy(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<PolicyBody>) -> ApiResult<Json<Value>> {
    if !require_view(&app, &me).await? {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só o dono do app muda as regras dos arquivos".into()));
    }
    let new = body.policy;
    new.check().map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    let old = crate::files::Policy::load(&app).await;
    app.db.set_setting("file_policy", &serde_json::to_string(&new).unwrap_or_default()).await?;
    for guild in [false, true] {
        if old.scope(guild).big_ttl_ms != new.scope(guild).big_ttl_ms {
            crate::files::retime_big(&app, guild, new.scope(guild).big_ttl_ms).await;
        }
    }
    if body.apply_to_guilds {
        app.db
            .execute(
                "UPDATE guilds SET file_ttl_ms = ?1, voice_ttl_ms = ?2",
                libsql::params![new.guild.file_ttl_ms, new.guild.voice_ttl_ms],
            )
            .await?;
        let ids = app.db.query_all("SELECT id FROM guilds", (), |r| r.get::<String>(0)).await?;
        for id in ids {
            let _ = crate::api::announce_guild(&app, &id).await;
        }
    }
    // Os apps abertos passam a avisar com os limites novos antes de enviar.
    app.hub.to_all("files:limits", crate::files::limits(&app).await);
    app.logs.info(format!("Regras dos arquivos mudadas por @{}", me.username));
    file_policy(State(app), AuthUser(me, String::new())).await
}

/// Quem pode ver o painel além do dono.
async fn viewers(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    require_view(&app, &me).await?;
    let sql = format!("SELECT {USER_COLS}, a.granted_at FROM app_admins a JOIN users u ON u.id = a.user_id ORDER BY a.granted_at");
    let base = crate::models::USER_COLS_LEN;
    let list = app
        .db
        .query_all(&sql, (), |r| Ok(json!({ "user": user_from_row(r)?, "grantedAt": r.get::<i64>(base)? })))
        .await?;
    Ok(Json(json!({ "owner": owner_username(), "viewers": list })))
}

#[derive(Deserialize)]
struct GrantBody {
    username: String,
}

/// Libera o painel para alguém (só o dono).
async fn grant(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<GrantBody>) -> ApiResult<Json<Value>> {
    if !require_view(&app, &me).await? {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só o dono do app escolhe quem vê o painel".into()));
    }
    let name = body.username.trim().trim_start_matches('@').to_string();
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.username = ?1 COLLATE NOCASE");
    let user = app
        .db
        .query_one(&sql, [name.as_str()], user_from_row)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("Ninguém com o usuário @{name}")))?;
    if user.username.to_lowercase() == owner_username() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "O dono do app já vê o painel".into()));
    }
    app.db
        .execute(
            "INSERT OR IGNORE INTO app_admins (user_id, granted_at) VALUES (?1, ?2)",
            libsql::params![user.id.as_str(), crate::now_ms()],
        )
        .await?;
    app.hub.to_user(&user.id, "admin:access", json!({ "canView": true, "owner": false }));
    viewers(State(app), AuthUser(me, String::new())).await
}

/// Tira o acesso de alguém (só o dono).
async fn revoke(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if !require_view(&app, &me).await? {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só o dono do app escolhe quem vê o painel".into()));
    }
    app.db.execute("DELETE FROM app_admins WHERE user_id = ?1", [id.as_str()]).await?;
    app.hub.to_user(&id, "admin:access", json!({ "canView": false, "owner": false }));
    viewers(State(app), AuthUser(me, String::new())).await
}
