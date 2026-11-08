//! Tarefas agendadas do assistente: mandar uma mensagem mais tarde (uma vez ou repetindo).
//!
//! A pessoa pede ("daqui a 2 horas manda no #geral…", "todo dia às 9h…"), confirma o cartão, e a tarefa fica
//! em `agent_jobs` (o texto selado, como as mensagens). Uma rotina confere a cada `TICK` o que venceu e manda
//! em nome da pessoa, pelo mesmo caminho das mensagens dela (`Hub::act_as`): o acesso ao canal é conferido na
//! hora. Sem o assistente liberado para ela (desligado, ou tirado da lista do dono), a tarefa não roda.
use crate::host::App;
use crate::models::{user_from_row, User, USER_COLS};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// De quanto em quanto tempo a rotina procura tarefas vencidas.
const TICK: Duration = Duration::from_secs(15);
/// Tarefas guardadas por pessoa.
pub const MAX_JOBS: i64 = 20;
/// A repetição mais curta (minutos) e o mais longe que dá para agendar.
pub const MIN_REPEAT_MIN: i64 = 15;
const MAX_AHEAD_MS: i64 = 366 * 24 * 3600 * 1000;
/// Uma tarefa que repete e falha tantas vezes seguidas para.
const MAX_ERRORS: i64 = 3;

/// Agenda uma mensagem. `channel_id` já resolvido (canal ou conversa privada); `run_at` em ms (UTC).
pub async fn create(app: &App, me: &User, channel_id: &str, content: &str, run_at: i64, repeat_min: Option<i64>, label: &str) -> Result<Value, String> {
    let now = crate::now_ms();
    if content.trim().is_empty() || content.chars().count() > 4000 {
        return Err("Mensagem vazia ou longa demais".into());
    }
    if run_at < now - 60_000 || run_at > now + MAX_AHEAD_MS {
        return Err("A hora precisa ser no futuro (até um ano)".into());
    }
    if let Some(r) = repeat_min {
        if !(MIN_REPEAT_MIN..=366 * 24 * 60).contains(&r) {
            return Err(format!("A repetição precisa ser de {MIN_REPEAT_MIN} minutos a um ano"));
        }
    }
    let count = app
        .db
        .query_one("SELECT COUNT(*) FROM agent_jobs WHERE user_id = ?1", [me.id.as_str()], |r| r.get::<i64>(0))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if count >= MAX_JOBS {
        return Err(format!("Você já tem {MAX_JOBS} tarefas agendadas; cancele alguma antes"));
    }
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let label: String = label.chars().take(80).collect();
    app.db
        .execute(
            "INSERT INTO agent_jobs (id, user_id, channel_id, content, run_at, repeat_min, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            libsql::params![id.as_str(), me.id.as_str(), channel_id, app.db.cipher.seal(content), run_at.max(now), repeat_min, label.as_str(), now],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "jobId": id, "runAt": run_at.max(now), "repeatMinutes": repeat_min }))
}

/// As tarefas da pessoa (com o texto, para ela conferir).
pub async fn list(app: &App, me: &User) -> Result<Vec<Value>, String> {
    let rows = app
        .db
        .query_all(
            "SELECT id, channel_id, content, run_at, repeat_min, label, runs, last_error FROM agent_jobs WHERE user_id = ?1 ORDER BY run_at",
            [me.id.as_str()],
            |r| {
                Ok((
                    r.get::<String>(0)?,
                    r.get::<String>(1)?,
                    r.get::<String>(2)?,
                    r.get::<i64>(3)?,
                    r.get::<Option<i64>>(4)?,
                    r.get::<String>(5)?,
                    r.get::<i64>(6)?,
                    r.get::<Option<String>>(7)?,
                ))
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, channel, content, run_at, repeat, label, runs, err)| {
            let text = app.db.cipher.reveal(&content);
            json!({ "jobId": id, "channelId": channel, "content": text, "runAt": run_at, "repeatMinutes": repeat, "label": label, "runs": runs, "lastError": err })
        })
        .collect())
}

/// Cancela uma tarefa da pessoa.
pub async fn cancel(app: &App, me: &User, id: &str) -> Result<Value, String> {
    let n = app
        .db
        .execute("DELETE FROM agent_jobs WHERE id = ?1 AND user_id = ?2", [id, me.id.as_str()])
        .await
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Essa tarefa não existe (ou já rodou)".into());
    }
    Ok(json!({ "ok": true }))
}

/// Sobe a rotina que manda as mensagens agendadas.
pub fn start(app: Arc<App>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        loop {
            tokio::select! {
                _ = tick.tick() => run_due(&app).await,
                _ = app.hub.shutdown.cancelled() => break,
            }
        }
    });
}

struct Due {
    id: String,
    user_id: String,
    channel_id: String,
    content: String,
    run_at: i64,
    repeat_min: Option<i64>,
    errors: i64,
}

async fn run_due(app: &Arc<App>) {
    if !crate::agent::enabled(app).await {
        return;
    }
    let now = crate::now_ms();
    let due = app
        .db
        .query_all(
            "SELECT id, user_id, channel_id, content, run_at, repeat_min, errors FROM agent_jobs WHERE run_at <= ?1 ORDER BY run_at LIMIT 20",
            [now],
            |r| {
                Ok(Due {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    channel_id: r.get(2)?,
                    content: r.get(3)?,
                    run_at: r.get(4)?,
                    repeat_min: r.get(5)?,
                    errors: r.get(6)?,
                })
            },
        )
        .await
        .unwrap_or_default();
    for job in due {
        let result = run_one(app, &job).await;
        let next = job.repeat_min.map(|m| {
            // a próxima vez no futuro (o servidor pode ter ficado parado e perdido algumas)
            let step = m * 60_000;
            let missed = ((now - job.run_at) / step).max(0) + 1;
            job.run_at + missed * step
        });
        let done = match (&result, next) {
            (Ok(()), Some(next)) => app
                .db
                .execute("UPDATE agent_jobs SET run_at = ?1, runs = runs + 1, errors = 0, last_error = NULL WHERE id = ?2", libsql::params![next, job.id.as_str()])
                .await
                .map(|_| ()),
            (Err(e), Some(next)) if job.errors + 1 < MAX_ERRORS => app
                .db
                .execute(
                    "UPDATE agent_jobs SET run_at = ?1, errors = errors + 1, last_error = ?2 WHERE id = ?3",
                    libsql::params![next, e.as_str(), job.id.as_str()],
                )
                .await
                .map(|_| ()),
            _ => app.db.execute("DELETE FROM agent_jobs WHERE id = ?1", [job.id.as_str()]).await.map(|_| ()),
        };
        if let Err(e) = &result {
            app.logs.warn(format!("Assistente: tarefa agendada {} não rodou: {e}", job.id));
            app.hub.to_user(&job.user_id, "agent:notice", json!({ "title": "Tarefa agendada", "body": format!("A mensagem agendada não foi enviada: {e}") }));
        }
        if let Err(e) = done {
            app.logs.warn(format!("Assistente: tarefa agendada {}: {e}", job.id));
        }
    }
}

async fn run_one(app: &Arc<App>, job: &Due) -> Result<(), String> {
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    let user = app.db.query_one(&sql, [job.user_id.as_str()], user_from_row).await.map_err(|e| e.to_string())?.ok_or("a conta não existe mais")?;
    if !crate::agent::has_access_for(app, &user).await {
        return Err("o assistente não está mais liberado para você".into());
    }
    let content = app.db.cipher.reveal(&job.content);
    let res = app.hub.act_as(app, &user, "message:send", json!({ "channelId": job.channel_id, "content": content })).await;
    match res.get("error").and_then(Value::as_str) {
        Some(e) => Err(e.to_string()),
        None => Ok(()),
    }
}
