//! Mensagens fixadas e favoritas.
//!
//! Fixada: vale para todos da conversa ou do canal e aparece no menu do alfinete. Nas conversas
//! privadas, qualquer um dos dois fixa; nos servidores, quem tem a permissão de fixar (`perm::PIN`,
//! liberada para todos por padrão). Até `MAX_PINS` por conversa ou canal. Quem está com o app aberto
//! fica sabendo na hora (`pin:update`).
//!
//! Favorita: só de quem favoritou, como as outras marcas (`message_marks`, tipo `star`, em
//! `social.rs`). Aqui fica a lista do menu da estrela, com o texto e o lugar de cada uma.
use crate::api::{channel_with_access, perm, ApiError, AuthUser};
use crate::host::App;
use crate::models::*;
use crate::social::{dm_with_access, DmChannel};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Fixadas por conversa ou canal.
const MAX_PINS: i64 = 50;
/// Favoritas que o menu mostra (as mais recentes).
const MAX_STARS: i64 = 300;

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/channels/{id}/pins", get(list_pins))
        .route("/api/messages/{id}/pin", put(pin).delete(unpin))
        .route("/api/me/stars", get(list_stars))
}

fn not_found(msg: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, msg)
}

/// Onde está uma mensagem que a pessoa pode ver.
pub enum Place {
    Channel { guild_id: String, channel_id: String },
    Dm(DmChannel),
}

impl Place {
    pub fn channel_id(&self) -> &str {
        match self {
            Place::Channel { channel_id, .. } => channel_id,
            Place::Dm(dm) => &dm.id,
        }
    }

    /// Avisa quem está nesta conversa ou neste canal.
    fn tell(&self, app: &App, event: &str, d: Value) {
        match self {
            Place::Channel { guild_id, channel_id } => app.hub.to_channel(guild_id, channel_id, event, d),
            Place::Dm(dm) => app.hub.to_users(&dm.users(), event, d),
        }
    }
}

/// A mensagem e onde ela está, se a pessoa tiver acesso.
async fn locate(app: &App, message_id: &str, user_id: &str) -> Option<(Place, String)> {
    let in_channel = app
        .db
        .query_one("SELECT channel_id, content FROM messages WHERE id = ?1", [message_id], |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?)))
        .await
        .ok()
        .flatten();
    if let Some((channel_id, content)) = in_channel {
        let ch = channel_with_access(app, &channel_id, user_id).await?;
        return Some((Place::Channel { guild_id: ch.guild_id, channel_id: ch.id }, content));
    }
    let (dm_id, content) = app
        .db
        .query_one("SELECT dm_id, content FROM dm_messages WHERE id = ?1", [message_id], |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?)))
        .await
        .ok()
        .flatten()?;
    Some((Place::Dm(dm_with_access(app, &dm_id, user_id).await?), content))
}

/// Fixadas de uma conversa ou canal, da fixada mais recente para a mais antiga.
async fn list_pins(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Value>>> {
    let (select, col, place) = match channel_with_access(&app, &id, &me.id).await.filter(|c| c.kind == "text") {
        Some(ch) => (MESSAGE_SELECT, "m.channel_id", ch.id),
        None => {
            let dm = dm_with_access(&app, &id, &me.id).await.ok_or_else(|| not_found("Conversa não encontrada"))?;
            (DM_MESSAGE_SELECT, "m.dm_id", dm.id)
        }
    };
    let pins: HashMap<String, (String, i64)> = app
        .db
        .query_all("SELECT message_id, pinned_by, pinned_at FROM pins WHERE channel_id = ?1", [place.as_str()], |r| {
            Ok((r.get::<String>(0)?, (r.get::<String>(1)?, r.get::<i64>(2)?)))
        })
        .await?
        .into_iter()
        .collect();
    let sql = format!("{select} WHERE {col} = ?1 AND m.id IN (SELECT message_id FROM pins WHERE channel_id = ?1)");
    let mut list = app.db.query_all(&sql, [place.as_str()], message_from_row).await?;
    for m in &mut list {
        open_message(&app.db, m);
    }
    attach_reactions(&app.db, &mut list).await?;
    let mut out: Vec<(i64, Value)> = list
        .into_iter()
        .filter_map(|m| {
            let (by, at) = pins.get(&m.id)?.clone();
            let mut v = serde_json::to_value(&m).ok()?;
            v["pinnedBy"] = json!(by);
            v["pinnedAt"] = json!(at);
            Some((at, v))
        })
        .collect();
    out.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    Ok(Json(out.into_iter().map(|(_, v)| v).collect()))
}

async fn pin(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    set_pin(&app, &me, &id, true).await
}

async fn unpin(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    set_pin(&app, &me, &id, false).await
}

async fn set_pin(app: &App, me: &User, message_id: &str, on: bool) -> ApiResult<StatusCode> {
    let (place, sealed) = locate(app, message_id, &me.id).await.ok_or_else(|| not_found("Mensagem não encontrada"))?;
    if let Place::Channel { guild_id, .. } = &place {
        let allowed = crate::api::member_perms(app, guild_id, &me.id).await?.is_some_and(|p| perm::has(p, perm::PIN));
        if !allowed {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Você não tem permissão para fixar mensagens neste servidor"));
        }
    }
    let channel_id = place.channel_id().to_string();
    if on {
        let count = app
            .db
            .query_one("SELECT COUNT(*) FROM pins WHERE channel_id = ?1", [channel_id.as_str()], |r| r.get::<i64>(0))
            .await?
            .unwrap_or(0);
        if count >= MAX_PINS {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("Já há {MAX_PINS} mensagens fixadas aqui: desafixe alguma para fixar outra"),
            ));
        }
        let added = app
            .db
            .execute(
                "INSERT OR IGNORE INTO pins (message_id, channel_id, pinned_by, pinned_at) VALUES (?1, ?2, ?3, ?4)",
                libsql::params![message_id, channel_id.as_str(), me.id.as_str(), crate::now_ms()],
            )
            .await?;
        if added == 0 {
            return Ok(StatusCode::NO_CONTENT);
        }
    } else if app.db.execute("DELETE FROM pins WHERE message_id = ?1", [message_id]).await? == 0 {
        return Ok(StatusCode::NO_CONTENT);
    }
    place.tell(app, "pin:update", json!({ "channelId": channel_id, "messageId": message_id, "on": on, "by": me.id }));
    if let Place::Channel { guild_id, channel_id } = &place {
        let text = reply_preview(&app.db.cipher.reveal(&sealed));
        let kind = if on { "message.pin" } else { "message.unpin" };
        app.audit(crate::audit::Entry::new(guild_id, kind, &me.id).channel(channel_id).detail(json!({ "id": message_id, "text": text })));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Minhas favoritas (as mais recentes primeiro), com o lugar de cada uma: o servidor e o canal, ou
/// a pessoa da conversa privada. Some da lista o que eu não vejo mais ou foi apagado.
async fn list_stars(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Vec<Value>>> {
    let stars: Vec<(String, i64)> = app
        .db
        .query_all(
            "SELECT message_id, created_at FROM message_marks WHERE user_id = ?1 AND kind = 'star' ORDER BY created_at DESC LIMIT ?2",
            libsql::params![me.id.as_str(), MAX_STARS],
            |r| Ok((r.get::<String>(0)?, r.get::<i64>(1)?)),
        )
        .await?;
    if stars.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let ids: Vec<String> = stars.iter().map(|(id, _)| id.clone()).collect();
    let marks = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let mut found = app
        .db
        .query_all(&format!("{MESSAGE_SELECT} WHERE m.id IN ({marks})"), libsql::params_from_iter(ids.clone()), message_from_row)
        .await?;
    let in_guilds = found.len();
    found.extend(
        app.db
            .query_all(&format!("{DM_MESSAGE_SELECT} WHERE m.id IN ({marks})"), libsql::params_from_iter(ids), message_from_row)
            .await?,
    );
    // Lugar de cada conversa/canal (uma consulta por lugar), ou `None` se eu não vejo mais.
    let mut places: HashMap<String, Option<Value>> = HashMap::new();
    let mut keep: Vec<Message> = Vec::new();
    for (i, mut m) in found.into_iter().enumerate() {
        if !places.contains_key(&m.channel_id) {
            let place = if i < in_guilds { channel_place(&app, &m.channel_id, &me.id).await } else { dm_place(&app, &m.channel_id, &me.id).await };
            places.insert(m.channel_id.clone(), place);
        }
        if places[&m.channel_id].is_some() {
            open_message(&app.db, &mut m);
            keep.push(m);
        }
    }
    attach_reactions(&app.db, &mut keep).await?;
    let when: HashMap<String, i64> = stars.into_iter().collect();
    let mut out: Vec<(i64, Value)> = keep
        .into_iter()
        .filter_map(|m| {
            let at = *when.get(&m.id)?;
            let place = places.get(&m.channel_id)?.clone()?;
            let mut v = serde_json::to_value(&m).ok()?;
            v["starredAt"] = json!(at);
            v["place"] = place;
            Some((at, v))
        })
        .collect();
    out.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    Ok(Json(out.into_iter().map(|(_, v)| v).collect()))
}

async fn channel_place(app: &App, channel_id: &str, user_id: &str) -> Option<Value> {
    let ch = channel_with_access(app, channel_id, user_id).await?;
    let guild_name = app
        .db
        .query_one("SELECT name FROM guilds WHERE id = ?1", [ch.guild_id.as_str()], |r| r.get::<String>(0))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    Some(json!({ "guildId": ch.guild_id, "guildName": guild_name, "channelName": ch.name }))
}

async fn dm_place(app: &App, dm_id: &str, user_id: &str) -> Option<Value> {
    let dm = dm_with_access(app, dm_id, user_id).await?;
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    let other = app.db.query_one(&sql, [dm.other(user_id)], user_from_row).await.ok().flatten()?;
    Some(json!({ "dm": true, "recipient": other }))
}
