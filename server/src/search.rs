//! Pesquisa nas mensagens de uma conversa privada ou dos canais de texto de um servidor.
//!
//! As mensagens ficam cifradas no banco, então o banco não consegue procurar: o servidor lê as
//! mensagens da mais nova para a mais antiga em lotes, abre cada uma e confere o texto sem diferenciar
//! maiúsculas nem acentos (todas as palavras precisam aparecer; nos arquivos vale também o nome).
//! Cada pedido lê no máximo `SCAN_MAX` mensagens e devolve até `MAX_RESULTS`; o app pede o resto
//! com `before` (o `next` da resposta).
use crate::api::{channel_with_access, ApiError, AuthUser};
use crate::host::App;
use crate::models::*;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

const MAX_RESULTS: usize = 25;
const SCAN_MAX: usize = 20_000;
const BATCH: i64 = 1000;

pub fn router() -> Router<Arc<App>> {
    Router::new().route("/api/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    /// Um canal de texto ou uma conversa privada.
    #[serde(default)]
    channel: Option<String>,
    /// Ou todos os canais de texto que a pessoa vê num servidor.
    #[serde(default)]
    guild: Option<String>,
    /// Continua de onde a pesquisa anterior parou (mensagens mais antigas que isto).
    #[serde(default)]
    before: Option<i64>,
}

/// Palavras da pesquisa, já sem acento e em minúsculas.
fn words(q: &str) -> Vec<String> {
    fold(q).split_whitespace().map(str::to_string).take(10).collect()
}

fn matches(content: &str, words: &[String]) -> bool {
    let text = fold(&search_text(content));
    words.iter().all(|w| text.contains(w.as_str()))
}

async fn search(State(app): AppState, AuthUser(me, _): AuthUser, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let bad = |m: &str| ApiError::new(StatusCode::BAD_REQUEST, m);
    let words = words(&q.q);
    if words.is_empty() || q.q.chars().count() > 200 {
        return Err(bad("Escreva o que procurar"));
    }
    // Onde procurar: tabela, coluna do lugar e os lugares.
    let (table, col, places, select) = if let Some(guild) = q.guild.as_deref() {
        let channels = crate::api::visible_text_channels(&app, guild, &me.id).await?;
        if channels.is_empty() {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "Servidor não encontrado"));
        }
        ("messages", "channel_id", channels.into_iter().map(|c| c.id).collect::<Vec<_>>(), MESSAGE_SELECT)
    } else {
        let id = q.channel.as_deref().ok_or_else(|| bad("Diga onde procurar"))?;
        match channel_with_access(&app, id, &me.id).await.filter(|c| c.kind == "text") {
            Some(ch) => ("messages", "channel_id", vec![ch.id], MESSAGE_SELECT),
            None => {
                let dm = crate::social::dm_with_access(&app, id, &me.id)
                    .await
                    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Conversa não encontrada"))?;
                ("dm_messages", "dm_id", vec![dm.id], DM_MESSAGE_SELECT)
            }
        }
    };
    let marks = (2..places.len() + 2).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT id, content, created_at FROM {table} WHERE {col} IN ({marks}) AND created_at < ?1 ORDER BY created_at DESC LIMIT {BATCH}"
    );
    let mut cursor = q.before.unwrap_or(i64::MAX);
    let mut found: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut ended = false;
    while found.len() < MAX_RESULTS && scanned < SCAN_MAX {
        let mut params: Vec<libsql::Value> = vec![cursor.into()];
        params.extend(places.iter().map(|p| libsql::Value::from(p.clone())));
        let rows = app
            .db
            .query_all(&sql, libsql::params_from_iter(params), |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<i64>(2)?)))
            .await?;
        let full = rows.len() as i64 == BATCH;
        for (id, sealed, created_at) in rows {
            scanned += 1;
            cursor = created_at;
            if matches(&app.db.cipher.reveal(&sealed), &words) {
                found.push(id);
                if found.len() >= MAX_RESULTS {
                    break;
                }
            }
        }
        if !full && found.len() < MAX_RESULTS {
            ended = true;
            break;
        }
    }
    let mut results = Vec::new();
    if !found.is_empty() {
        let marks = (1..=found.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let sql = format!("{select} WHERE m.id IN ({marks}) ORDER BY m.created_at DESC");
        results = app.db.query_all(&sql, libsql::params_from_iter(found), message_from_row).await?;
        for m in &mut results {
            open_message(&app.db, m);
        }
        attach_reactions(&app.db, &mut results).await?;
    }
    Ok(Json(json!({ "results": results, "next": (!ended).then_some(cursor), "scanned": scanned })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todas_as_palavras_sem_acento() {
        let w = words("  Reunião  AMANHÃ ");
        assert_eq!(w, vec!["reuniao", "amanha"]);
        assert!(matches("a **reuniao** é amanhã cedo", &w));
        assert!(!matches("a reunião foi ontem", &w));
        let id = "0123456789abcdef0123456789abcdef";
        assert!(matches(&format!("[arquivo:{id}:10:application/pdf:Reunião-amanhã.pdf]"), &w));
        assert!(!matches(&format!("[arquivo:{id}:10:application/pdf:ata.pdf]"), &words(id)));
    }
}
