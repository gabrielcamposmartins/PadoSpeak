//! Tarefas agendadas do assistente, de qualquer tipo, uma vez ou repetindo:
//! - `message`: manda uma mensagem num canal ou numa conversa privada;
//! - `action`: roda uma ferramenta exata do assistente (a que a pessoa viu no cartão), com os mesmos parâmetros:
//!   tirar um cargo, encerrar uma enquete, pôr uma música…;
//! - `task`: uma instrução que o assistente faz sozinho na hora ("todo dia às 9h resuma o #geral"); o resumo do
//!   que ele fez chega para a pessoa como aviso e fica na conversa dela com o assistente.
//!
//! A pessoa pede, confirma o cartão, e a tarefa fica em `agent_jobs` (o conteúdo selado, como as mensagens). Uma
//! rotina confere a cada `TICK` o que venceu e roda em nome da pessoa, com as permissões dela conferidas na hora.
//! Sem o assistente liberado para ela (desligado, ou tirado da lista do dono), a tarefa não roda.
use crate::host::App;
use crate::models::{user_from_row, User, USER_COLS};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// De quanto em quanto tempo a rotina procura tarefas vencidas.
const TICK: Duration = Duration::from_secs(15);
/// Tarefas guardadas por pessoa.
pub const MAX_JOBS: i64 = 20;
/// A repetição mais curta (minutos): mensagens e ações; tarefas do assistente (cada uma chama o modelo).
pub const MIN_REPEAT_MIN: i64 = 15;
pub const MIN_REPEAT_TASK_MIN: i64 = 60;
const MAX_AHEAD_MS: i64 = 366 * 24 * 3600 * 1000;
/// Uma tarefa que repete e falha tantas vezes seguidas para.
const MAX_ERRORS: i64 = 3;
/// Tamanho máximo do conteúdo (texto, instrução ou a ação em JSON).
const MAX_CONTENT: usize = 4000;

/// Tarefas rodando agora (uma tarefa do assistente pode levar um minuto: a próxima volta não a pega de novo).
static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub struct NewJob<'a> {
    /// `message`, `action` ou `task`.
    pub kind: &'a str,
    /// Só nas mensagens: o canal ou a conversa já resolvidos.
    pub channel_id: &'a str,
    /// O texto da mensagem, a ação ({tool, input}) ou a instrução.
    pub content: &'a str,
    pub run_at: i64,
    pub repeat_min: Option<i64>,
    /// Como aparece na lista e nos avisos.
    pub label: &'a str,
    /// Fuso da pessoa (minutos).
    pub tz: i64,
}

/// Agenda uma tarefa (`run_at` em ms, UTC).
pub async fn create(app: &App, me: &User, job: NewJob<'_>) -> Result<Value, String> {
    let now = crate::now_ms();
    if !matches!(job.kind, "message" | "action" | "task") {
        return Err("Tipo de tarefa desconhecido".into());
    }
    if job.content.trim().is_empty() || job.content.chars().count() > MAX_CONTENT {
        return Err(match job.kind {
            "message" => "Mensagem vazia ou longa demais".into(),
            "task" => "A instrução da tarefa está vazia ou longa demais (até 4000 caracteres)".into(),
            _ => "A ação está vazia ou grande demais".into(),
        });
    }
    if job.run_at < now - 60_000 || job.run_at > now + MAX_AHEAD_MS {
        return Err("A hora precisa ser no futuro (até um ano)".into());
    }
    if let Some(r) = job.repeat_min {
        let min = if job.kind == "task" { MIN_REPEAT_TASK_MIN } else { MIN_REPEAT_MIN };
        if !(min..=366 * 24 * 60).contains(&r) {
            return Err(format!("A repetição precisa ser de {min} minutos a um ano"));
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
    let label: String = job.label.chars().take(120).collect();
    let run_at = job.run_at.max(now);
    app.db
        .execute(
            "INSERT INTO agent_jobs (id, user_id, channel_id, content, run_at, repeat_min, label, created_at, kind, tz) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            libsql::params![
                id.as_str(),
                me.id.as_str(),
                job.channel_id,
                app.db.cipher.seal(job.content),
                run_at,
                job.repeat_min,
                label.as_str(),
                now,
                job.kind,
                job.tz
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "jobId": id, "kind": job.kind, "runAt": run_at, "repeatMinutes": job.repeat_min }))
}

/// As tarefas da pessoa (com o conteúdo, para ela conferir).
pub async fn list(app: &App, me: &User) -> Result<Vec<Value>, String> {
    let rows = app
        .db
        .query_all(
            "SELECT id, channel_id, content, run_at, repeat_min, label, runs, last_error, kind FROM agent_jobs WHERE user_id = ?1 ORDER BY run_at",
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
                    r.get::<String>(8)?,
                ))
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, channel, content, run_at, repeat, label, runs, err, kind)| {
            let text = app.db.cipher.reveal(&content);
            let content = if kind == "action" { serde_json::from_str(&text).unwrap_or(Value::String(text)) } else { Value::String(text) };
            json!({ "jobId": id, "kind": kind, "channelId": channel, "content": content, "runAt": run_at, "repeatMinutes": repeat, "label": label, "runs": runs, "lastError": err })
        })
        .collect())
}

/// Todas as tarefas do app, para o painel do administrador: de quem é, o tipo, o rótulo e quando roda (sem o texto
/// das mensagens).
pub async fn list_all(app: &App) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT j.id, j.kind, j.channel_id, j.run_at, j.repeat_min, j.label, j.runs, j.errors, j.last_error, j.created_at, {USER_COLS} \
         FROM agent_jobs j JOIN users u ON u.id = j.user_id ORDER BY j.run_at"
    );
    let rows = app
        .db
        .query_all(&sql, (), |r| {
            Ok((
                r.get::<String>(0)?,
                r.get::<String>(1)?,
                r.get::<String>(2)?,
                r.get::<i64>(3)?,
                r.get::<Option<i64>>(4)?,
                r.get::<String>(5)?,
                r.get::<i64>(6)?,
                r.get::<i64>(7)?,
                r.get::<Option<String>>(8)?,
                r.get::<i64>(9)?,
                crate::models::user_at(r, 10)?,
            ))
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, kind, channel, run_at, repeat, label, runs, errors, last_error, created_at, user)| {
            json!({
                "id": id, "kind": kind, "channelId": channel, "runAt": run_at, "repeatMinutes": repeat, "label": label,
                "runs": runs, "errors": errors, "lastError": last_error, "createdAt": created_at, "user": user,
            })
        })
        .collect())
}

/// Apaga qualquer tarefa (painel do administrador). Devolve de quem era.
pub async fn remove_any(app: &App, id: &str) -> Result<Option<String>, String> {
    let owner = app
        .db
        .query_one("SELECT user_id FROM agent_jobs WHERE id = ?1", [id], |r| r.get::<String>(0))
        .await
        .map_err(|e| e.to_string())?;
    if owner.is_some() {
        app.db.execute("DELETE FROM agent_jobs WHERE id = ?1", [id]).await.map_err(|e| e.to_string())?;
    }
    Ok(owner)
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

/// Sobe a rotina que roda as tarefas agendadas.
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
    kind: String,
    label: String,
    tz: i64,
}

async fn run_due(app: &Arc<App>) {
    if !crate::agent::enabled(app).await {
        return;
    }
    let now = crate::now_ms();
    let due = app
        .db
        .query_all(
            "SELECT id, user_id, channel_id, content, run_at, repeat_min, errors, kind, label, tz FROM agent_jobs WHERE run_at <= ?1 ORDER BY run_at LIMIT 20",
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
                    kind: r.get(7)?,
                    label: r.get(8)?,
                    tz: r.get(9)?,
                })
            },
        )
        .await
        .unwrap_or_default();
    for job in due {
        if !RUNNING.lock().unwrap().get_or_insert_with(HashSet::new).insert(job.id.clone()) {
            continue;
        }
        // cada uma por conta própria: uma tarefa do assistente demorando não atrasa as mensagens dos outros
        let app = app.clone();
        tokio::spawn(async move {
            let result = run_one(&app, &job).await;
            // repetir depende do painel: quem perdeu o direito tem esta última vez e a tarefa para
            let repeats = job.repeat_min.is_some() && may_repeat(&app, &job.user_id).await;
            finish(&app, &job, result, repeats).await;
            RUNNING.lock().unwrap().get_or_insert_with(HashSet::new).remove(&job.id);
        });
    }
}

/// Grava como foi (a próxima vez, os erros) e avisa a pessoa.
async fn finish(app: &Arc<App>, job: &Due, result: Result<Option<String>, String>, repeats: bool) {
    let now = crate::now_ms();
    let next = job.repeat_min.filter(|_| repeats).map(|m| {
        // a próxima vez no futuro (o servidor pode ter ficado parado e perdido algumas)
        let step = m * 60_000;
        let missed = ((now - job.run_at) / step).max(0) + 1;
        job.run_at + missed * step
    });
    let done = match (&result, next) {
        (Ok(_), Some(next)) => app
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
    if let Err(e) = done {
        app.logs.warn(format!("Assistente: tarefa agendada {}: {e}", job.id));
    }
    let what = if job.label.is_empty() { "A tarefa agendada".to_string() } else { format!("A tarefa agendada “{}”", job.label) };
    match result {
        Err(e) => {
            app.logs.warn(format!("Assistente: tarefa agendada {} não rodou: {e}", job.id));
            notify(app, &job.user_id, &job.id, &format!("{what} não rodou: {e}"));
        }
        Ok(Some(summary)) => notify(app, &job.user_id, &job.id, &summary),
        Ok(None) => {}
    }
}

/// Se a pessoa ainda pode ter tarefas que se repetem (o painel decide: ninguém, administradores ou todos).
async fn may_repeat(app: &App, user_id: &str) -> bool {
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    match app.db.query_one(&sql, [user_id], user_from_row).await {
        Ok(Some(user)) => crate::agent::can_repeat(app, &user).await,
        _ => false,
    }
}

/// Aviso na tela (se o app está aberto) e notificação no celular (se não está).
fn notify(app: &App, user_id: &str, job_id: &str, body: &str) {
    let body: String = if body.chars().count() > 600 { body.chars().take(600).collect::<String>() + "…" } else { body.to_string() };
    let title = "Tarefa agendada";
    app.hub.to_user(user_id, "agent:notice", json!({ "title": title, "body": body, "at": crate::now_ms() }));
    app.push_to(
        user_id,
        crate::push::Note {
            title: title.into(),
            body,
            tag: format!("job:{job_id}"),
            url: "/".into(),
            kind: "message",
            from: None,
        },
    );
}

/// Roda a tarefa. `Ok(Some(texto))`: o que avisar à pessoa (ações e tarefas do assistente); mensagens vão caladas.
async fn run_one(app: &Arc<App>, job: &Due) -> Result<Option<String>, String> {
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    let user = app.db.query_one(&sql, [job.user_id.as_str()], user_from_row).await.map_err(|e| e.to_string())?.ok_or("a conta não existe mais")?;
    if !crate::agent::has_access_for(app, &user).await {
        return Err("o assistente não está mais liberado para você".into());
    }
    let content = app.db.cipher.reveal(&job.content);
    match job.kind.as_str() {
        "action" => {
            let v: Value = serde_json::from_str(&content).map_err(|_| "a ação guardada está estragada")?;
            let tool = v["tool"].as_str().ok_or("a ação guardada está estragada")?;
            crate::agent::run_scheduled_action(app, &user, tool, &v["input"]).await.map(Some)
        }
        "task" => crate::agent::run_scheduled_task(app, &user, &content, job.tz).await.map(Some),
        _ => {
            let res = app.hub.act_as(app, &user, "message:send", json!({ "channelId": job.channel_id, "content": content })).await;
            match res.get("error").and_then(Value::as_str) {
                Some(e) => Err(e.to_string()),
                None => Ok(None),
            }
        }
    }
}
