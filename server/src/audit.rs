//! Registro de cada servidor (configurações do servidor → Registro): quem entrou e saiu do servidor,
//! entradas e saídas dos canais de voz (com o tempo que a pessoa ficou), mensagens enviadas, editadas
//! e apagadas, e as mudanças nas configurações. O detalhe fica cifrado como as mensagens; o registro
//! guarda os últimos 90 dias.
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

type ApiResult<T> = Result<T, ApiError>;

/// Quanto tempo o registro guarda.
const KEEP_MS: i64 = 90 * 24 * 3600 * 1000;

/// Um acontecimento num servidor. `kind`: `grupo.ação` (member, voice, message, settings).
#[derive(Debug, Clone)]
pub struct Entry {
    pub guild_id: String,
    pub kind: &'static str,
    pub actor: Option<String>,
    pub target: Option<String>,
    pub channel: Option<String>,
    pub detail: Value,
}

impl Entry {
    pub fn new(guild_id: &str, kind: &'static str, actor: &str) -> Self {
        Entry { guild_id: guild_id.to_string(), kind, actor: Some(actor.to_string()), target: None, channel: None, detail: Value::Null }
    }
    pub fn target(mut self, id: &str) -> Self {
        self.target = Some(id.to_string());
        self
    }
    pub fn channel(mut self, id: &str) -> Self {
        self.channel = Some(id.to_string());
        self
    }
    pub fn detail(mut self, d: Value) -> Self {
        self.detail = d;
        self
    }
}

pub type Sender = UnboundedSender<Entry>;

impl App {
    /// Anota no registro do servidor (em segundo plano).
    pub fn audit(&self, e: Entry) {
        let _ = self.audit.send(e);
    }
}

/// Grava o que chega no banco (e apaga o que passou de 90 dias, de vez em quando).
pub fn spawn_writer(app: Arc<App>, mut rx: UnboundedReceiver<Entry>) {
    tokio::spawn(async move {
        let mut since_prune = 0u32;
        while let Some(e) = rx.recv().await {
            if e.guild_id.is_empty() {
                continue;
            }
            let detail = if e.detail.is_null() { None } else { Some(app.db.cipher.seal(&e.detail.to_string())) };
            let res = app
                .db
                .execute(
                    "INSERT INTO guild_log (guild_id, at, kind, actor_id, target_id, channel_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    libsql::params![e.guild_id.as_str(), crate::now_ms(), e.kind, e.actor, e.target, e.channel, detail],
                )
                .await;
            if let Err(err) = res {
                app.logs.warn(format!("Registro do servidor: {err}"));
            }
            since_prune += 1;
            if since_prune >= 500 {
                since_prune = 0;
                let _ = app.db.execute("DELETE FROM guild_log WHERE at < ?1", [crate::now_ms() - KEEP_MS]).await;
            }
        }
    });
}

pub fn router() -> Router<Arc<App>> {
    Router::new().route("/api/guilds/{id}/log", get(list))
}

#[derive(Deserialize)]
struct LogQuery {
    /// Grupo: member, voice, message ou settings (vazio = tudo).
    #[serde(default)]
    kind: String,
    /// Só o que essa pessoa fez ou sofreu.
    #[serde(default)]
    user: String,
    #[serde(default)]
    channel: String,
    /// Texto no detalhe (nomes, trecho da mensagem…).
    #[serde(default)]
    q: String,
    /// Só antes deste id (para "carregar mais").
    before: Option<i64>,
    /// Só a partir deste horário (ms).
    since: Option<i64>,
    limit: Option<i64>,
}

/// Registro de um servidor (administradores), do mais novo para o mais antigo.
async fn list(State(app): State<Arc<App>>, AuthUser(me, _): AuthUser, Path(id): Path<String>, Query(q): Query<LogQuery>) -> ApiResult<Json<Value>> {
    crate::api::require_perm(&app, &id, &me.id, crate::api::perm::ADMIN, "Apenas administradores veem o registro").await?;
    if !["", "member", "voice", "message", "settings"].contains(&q.kind.as_str()) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Filtro inválido".into()));
    }
    let limit = q.limit.unwrap_or(60).clamp(1, 200);
    let needle = q.q.trim().to_lowercase();
    // Com busca por texto, o detalhe só dá para conferir depois de decifrar: lê mais e filtra aqui.
    let fetch = if needle.is_empty() { limit } else { 2000 };
    let rows = app
        .db
        .query_all(
            "SELECT l.id, l.at, l.kind, l.actor_id, a.display_name, a.username, l.target_id, t.display_name, t.username, \
             l.channel_id, c.name, l.detail FROM guild_log l \
             LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users t ON t.id = l.target_id \
             LEFT JOIN channels c ON c.id = l.channel_id \
             WHERE l.guild_id = ?1 AND (?2 = '' OR l.kind LIKE ?2 || '.%') AND (?3 = '' OR l.actor_id = ?3 OR l.target_id = ?3) \
             AND (?4 = '' OR l.channel_id = ?4) AND l.id < ?5 AND l.at >= ?6 ORDER BY l.id DESC LIMIT ?7",
            libsql::params![
                id.as_str(),
                q.kind.as_str(),
                q.user.as_str(),
                q.channel.as_str(),
                q.before.unwrap_or(i64::MAX),
                q.since.unwrap_or(0),
                fetch
            ],
            |r| {
                Ok((
                    r.get::<i64>(0)?,
                    r.get::<i64>(1)?,
                    r.get::<String>(2)?,
                    (r.get::<Option<String>>(3)?, r.get::<Option<String>>(4)?, r.get::<Option<String>>(5)?),
                    (r.get::<Option<String>>(6)?, r.get::<Option<String>>(7)?, r.get::<Option<String>>(8)?),
                    (r.get::<Option<String>>(9)?, r.get::<Option<String>>(10)?),
                    r.get::<Option<String>>(11)?,
                ))
            },
        )
        .await?;
    let person = |(id, name, username): (Option<String>, Option<String>, Option<String>)| {
        id.map(|id| json!({ "id": id, "name": crate::models::plain_text(&name.unwrap_or_default()), "username": username.unwrap_or_default() }))
    };
    let mut out = Vec::new();
    let mut scanned_last = None;
    let full_page = rows.len() as i64 >= fetch;
    for (lid, at, kind, actor, target, (channel_id, channel_name), detail) in rows {
        scanned_last = Some(lid);
        let detail: Value = detail.map(|d| serde_json::from_str(&app.db.cipher.reveal(&d)).unwrap_or(Value::Null)).unwrap_or(Value::Null);
        let entry = json!({
            "id": lid, "at": at, "kind": kind, "actor": person(actor), "target": person(target),
            "channelId": channel_id, "channelName": channel_name, "detail": detail,
        });
        if !needle.is_empty() && !entry.to_string().to_lowercase().contains(&needle) {
            continue;
        }
        out.push(entry);
        if out.len() as i64 >= limit {
            break;
        }
    }
    // Próxima página: antes do último conferido (pode haver mais se a página encheu ou se a busca
    // ainda não leu tudo).
    let next = if out.len() as i64 >= limit || full_page { scanned_last } else { None };
    Ok(Json(json!({ "entries": out, "next": next })))
}
