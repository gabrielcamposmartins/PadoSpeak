//! Enquetes nos canais de texto dos servidores.
//!
//! A enquete é uma mensagem como as outras (selada no banco), com o texto `[enquete]` seguido de uma linha com
//! o JSON da pergunta: `{"q": pergunta, "o": [opções], "m": várias respostas, "e": fim em ms ou null}`. Os votos
//! ficam em `poll_votes` (um por opção escolhida) e vão junto da mensagem em `poll`, já contados.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TAG: &str = "[enquete]";
pub const MAX_QUESTION: usize = 300;
pub const MAX_OPTION: usize = 100;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 10;
/// Prazo mais longo: 30 dias.
pub const MAX_HOURS: i64 = 30 * 24;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Def {
    pub q: String,
    pub o: Vec<String>,
    #[serde(default)]
    pub m: bool,
    #[serde(default)]
    pub e: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollOption {
    pub text: String,
    /// Quem votou nesta opção, na ordem dos votos.
    pub users: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Poll {
    pub question: String,
    pub options: Vec<PollOption>,
    pub multiple: bool,
    /// Quando termina (ms); `None` = sem prazo, até quem criou encerrar.
    pub ends_at: Option<i64>,
    /// Já terminou (o prazo passou ou foi encerrada).
    pub closed: bool,
    /// Quantas pessoas votaram (alguém com várias respostas conta uma vez).
    pub voters: usize,
}

pub fn is_poll(content: &str) -> bool {
    content.starts_with(TAG)
}

/// A pergunta de uma mensagem de enquete.
pub fn parse(content: &str) -> Option<Def> {
    let rest = content.strip_prefix(TAG)?.trim_start_matches(['\r', '\n']);
    serde_json::from_str(rest).ok()
}

fn render(def: &Def) -> String {
    format!("{TAG}\n{}", serde_json::to_string(def).unwrap_or_default())
}

/// Confere a enquete que alguém mandou e devolve o texto a guardar. Aceita o prazo em horas (`h`, de agora) ou o
/// fim já calculado (`e`).
pub fn normalize(content: &str, now: i64) -> Result<String, &'static str> {
    let rest = content.strip_prefix(TAG).ok_or("Enquete inválida")?.trim_start_matches(['\r', '\n']);
    let v: Value = serde_json::from_str(rest).map_err(|_| "Enquete inválida")?;
    let q = v["q"].as_str().unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return Err("Escreva a pergunta da enquete");
    }
    if q.chars().count() > MAX_QUESTION {
        return Err("A pergunta da enquete é longa demais (até 300 letras)");
    }
    let mut o: Vec<String> = Vec::new();
    for item in v["o"].as_array().into_iter().flatten() {
        let text = item.as_str().unwrap_or_default().trim().replace(['\r', '\n'], " ");
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > MAX_OPTION {
            return Err("Uma opção da enquete é longa demais (até 100 letras)");
        }
        if o.iter().any(|x| crate::models::fold(x) == crate::models::fold(&text)) {
            return Err("A enquete tem duas opções iguais");
        }
        o.push(text);
    }
    if o.len() < MIN_OPTIONS {
        return Err("A enquete precisa de pelo menos 2 opções");
    }
    if o.len() > MAX_OPTIONS {
        return Err("A enquete pode ter até 10 opções");
    }
    let e = match (v["h"].as_f64(), v["e"].as_i64()) {
        (Some(h), _) if h > 0.0 => {
            if h > MAX_HOURS as f64 {
                return Err("A enquete pode durar até 30 dias");
            }
            Some(now + (h * 3_600_000.0) as i64)
        }
        (_, Some(e)) => {
            if e <= now || e > now + MAX_HOURS * 3_600_000 {
                return Err("O fim da enquete tem que ser daqui a no máximo 30 dias");
            }
            Some(e)
        }
        _ => None,
    };
    Ok(render(&Def { q, o, m: v["m"].as_bool().unwrap_or(false), e }))
}

/// A mesma enquete, encerrada agora.
pub fn closed_now(def: &Def, now: i64) -> String {
    render(&Def { e: Some(now), ..def.clone() })
}

pub fn is_closed(def: &Def, now: i64) -> bool {
    def.e.is_some_and(|e| e <= now)
}

/// Monta a enquete com os votos: linhas (usuário, opção) na ordem dos votos.
pub fn build(def: &Def, votes: &[(String, i64)], now: i64) -> Poll {
    let mut options: Vec<PollOption> = def.o.iter().map(|t| PollOption { text: t.clone(), users: Vec::new() }).collect();
    let mut voters = std::collections::HashSet::new();
    for (user, opt) in votes {
        if let Some(o) = usize::try_from(*opt).ok().and_then(|i| options.get_mut(i)) {
            o.users.push(user.clone());
            voters.insert(user.clone());
        }
    }
    Poll { question: def.q.clone(), options, multiple: def.m, ends_at: def.e, closed: is_closed(def, now), voters: voters.len() }
}

/// Como a enquete aparece citada, na pesquisa e nos avisos: "📊 Enquete: pergunta".
pub fn preview(content: &str) -> Option<String> {
    parse(content).map(|d| format!("📊 Enquete: {}", d.q))
}

/// O texto que a pesquisa procura: a pergunta e as opções.
pub fn search_text(content: &str) -> Option<String> {
    parse(content).map(|d| format!("{}\n{}", d.q, d.o.join("\n")))
}

pub async fn votes(db: &crate::db::Db, message_id: &str) -> Vec<(String, i64)> {
    db.query_all(
        "SELECT user_id, option FROM poll_votes WHERE message_id = ?1 ORDER BY created_at, option",
        [message_id],
        |r| Ok((r.get::<String>(0)?, r.get::<i64>(1)?)),
    )
    .await
    .unwrap_or_default()
}

/// A enquete de uma mensagem (já aberta) com os votos de agora.
pub async fn load(db: &crate::db::Db, message_id: &str, content: &str) -> Option<Poll> {
    let def = parse(content)?;
    Some(build(&def, &votes(db, message_id).await, crate::now_ms()))
}

/// Preenche `poll` nas mensagens de enquete de uma lista (o texto já aberto).
pub async fn attach(db: &crate::db::Db, list: &mut [crate::models::Message]) -> crate::db::DbResult<()> {
    let ids: Vec<String> = list.iter().filter(|m| is_poll(&m.content)).map(|m| m.id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let marks = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT message_id, user_id, option FROM poll_votes WHERE message_id IN ({marks}) ORDER BY created_at, option");
    let rows = db
        .query_all(&sql, libsql::params_from_iter(ids), |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<i64>(2)?)))
        .await?;
    let mut by: std::collections::HashMap<String, Vec<(String, i64)>> = std::collections::HashMap::new();
    for (m, u, o) in rows {
        by.entry(m).or_default().push((u, o));
    }
    let now = crate::now_ms();
    for m in list.iter_mut() {
        if let Some(def) = parse(&m.content) {
            m.poll = Some(build(&def, by.get(&m.id).map(Vec::as_slice).unwrap_or_default(), now));
        }
    }
    Ok(())
}

/// Os votos de alguém viram exatamente `choices` (vazio tira o voto).
pub async fn set_vote(db: &crate::db::Db, message_id: &str, user_id: &str, choices: &[usize]) -> crate::db::DbResult<()> {
    db.execute("DELETE FROM poll_votes WHERE message_id = ?1 AND user_id = ?2", [message_id, user_id]).await?;
    let now = crate::now_ms();
    for (i, c) in choices.iter().enumerate() {
        db.execute(
            "INSERT OR IGNORE INTO poll_votes (message_id, user_id, option, created_at) VALUES (?1, ?2, ?3, ?4)",
            libsql::params![message_id, user_id, *c as i64, now + i as i64],
        )
        .await?;
    }
    Ok(())
}

/// Confere a escolha: índices válidos, sem repetir e só um quando a enquete é de uma resposta.
pub fn check_choices(def: &Def, raw: &Value) -> Result<Vec<usize>, &'static str> {
    let mut out: Vec<usize> = Vec::new();
    let list: Vec<Value> = match raw {
        Value::Array(a) => a.clone(),
        Value::Null => Vec::new(),
        v => vec![v.clone()],
    };
    for v in list {
        let i = v.as_u64().ok_or("Opção inválida")? as usize;
        if i >= def.o.len() {
            return Err("Opção inválida");
        }
        if !out.contains(&i) {
            out.push(i);
        }
    }
    if !def.m && out.len() > 1 {
        return Err("Esta enquete aceita só uma resposta");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enquete_confere_e_normaliza() {
        let now = 1_000_000;
        let c = normalize(r#"[enquete]
{"q":"  Pizza ou lanche? ","o":["Pizza"," Lanche ",""],"h":24}"#, now).unwrap();
        let d = parse(&c).unwrap();
        assert_eq!(d, Def { q: "Pizza ou lanche?".into(), o: vec!["Pizza".into(), "Lanche".into()], m: false, e: Some(now + 86_400_000) });
        assert_eq!(preview(&c).unwrap(), "📊 Enquete: Pizza ou lanche?");
        assert!(normalize(r#"[enquete]
{"q":"x","o":["a"]}"#, now).is_err());
        assert!(normalize(r#"[enquete]
{"q":"x","o":["Sim","sim"]}"#, now).is_err());
        assert!(normalize(r#"[enquete]
{"q":"x","o":["a","b"],"h":1000}"#, now).is_err());
        assert!(normalize("[enquete]\nnão é json", now).is_err());
        // sem prazo
        assert_eq!(parse(&normalize(r#"[enquete]
{"q":"x","o":["a","b"],"m":true}"#, now).unwrap()).unwrap().e, None);
    }

    #[test]
    fn votos_contados() {
        let d = Def { q: "?".into(), o: vec!["a".into(), "b".into(), "c".into()], m: true, e: Some(10) };
        let p = build(&d, &[("ana".into(), 0), ("ana".into(), 2), ("bia".into(), 2), ("x".into(), 9)], 5);
        assert_eq!(p.options[0].users, vec!["ana"]);
        assert_eq!(p.options[2].users, vec!["ana", "bia"]);
        assert_eq!(p.voters, 2);
        assert!(!p.closed);
        assert!(build(&d, &[], 10).closed);
        assert_eq!(check_choices(&d, &serde_json::json!([2, 0, 2])).unwrap(), vec![2, 0]);
        let single = Def { m: false, ..d.clone() };
        assert!(check_choices(&single, &serde_json::json!([0, 1])).is_err());
        assert!(check_choices(&single, &serde_json::json!([5])).is_err());
        assert_eq!(check_choices(&single, &serde_json::json!(1)).unwrap(), vec![1]);
        assert!(check_choices(&single, &Value::Null).unwrap().is_empty());
    }
}
