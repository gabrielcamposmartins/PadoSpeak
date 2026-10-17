//! Sons rápidos: cada pessoa tem uma biblioteca de até 10 sons curtos (MP3, OGG, WAV ou M4A, até 5 s e
//! 1 MB) e escolhe quais ficam nos botões do atalho (6 ou 9, em 2 ou 3 linhas). Na chamada, tocar um som
//! (`sound:play` no WebSocket, ver `hub.rs`) faz todos do canal ouvirem. Dá para copiar o som de outra
//! pessoa para a sua biblioteca.
//!
//! O áudio é público pelo id (como os stickers): quem está na chamada baixa para tocar.
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Tamanho máximo de um som.
pub const MAX_SOUND: usize = 1024 * 1024;
/// Duração máxima (contada pelo app ao enviar).
pub const MAX_DURATION_MS: i64 = 5_000;
/// Sons na biblioteca de cada pessoa.
pub const MAX_PER_USER: i64 = 10;
/// Botões do atalho: 3 por linha, de 1 a 3 linhas (escolhido em Configurações → Sons).
pub const MIN_ROWS: i64 = 1;
pub const MAX_ROWS: i64 = 3;

/// Ícones (desenhados no app) e cores de gel que um som pode ter.
pub const ICONS: [&str; 10] = ["horn", "clap", "drum", "laugh", "cricket", "cloud", "bell", "star", "heart", "boom"];
pub const TONES: [&str; 7] = ["aqua", "lime", "sun", "coral", "violet", "teal", "sky"];

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/sounds", get(library).post(upload).layer(DefaultBodyLimit::max(MAX_SOUND + 64 * 1024)))
        .route("/api/sounds/board", put(set_board))
        .route("/api/sounds/{id}", patch(edit).delete(remove))
        .route("/api/sounds/{id}/audio", get(audio))
        .route("/api/sounds/{id}/copy", post(copy))
        .route("/api/users/{id}/sounds", get(of_user))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub icon: String,
    pub tone: String,
    pub duration_ms: i64,
    pub url: String,
}

const COLS: &str = "id, owner_id, name, icon, tone, duration_ms";

fn from_row(r: &libsql::Row) -> Result<Sound, libsql::Error> {
    let id: String = r.get(0)?;
    Ok(Sound {
        url: format!("/api/sounds/{id}/audio"),
        id,
        owner_id: r.get(1)?,
        name: r.get(2)?,
        icon: r.get(3)?,
        tone: r.get(4)?,
        duration_ms: r.get(5)?,
    })
}

fn bad(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}

/// Tipo do áudio pelos primeiros bytes (não confia na extensão).
pub fn sniff_audio(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    if data.starts_with(b"ID3") || (data[0] == 0xFF && data[1] & 0xE0 == 0xE0) {
        return Some("audio/mpeg");
    }
    if data.starts_with(b"OggS") {
        return Some("audio/ogg");
    }
    if data.starts_with(b"RIFF") && &data[8..12] == b"WAVE" {
        return Some("audio/wav");
    }
    if &data[4..8] == b"ftyp" {
        return Some("audio/mp4");
    }
    None
}

/// Nome, ícone e cor válidos (o que vier fora da lista vira o padrão).
fn clean_meta(name: Option<&str>, icon: Option<&str>, tone: Option<&str>) -> (Option<String>, Option<String>, Option<String>) {
    let name = name.map(|n| n.trim().chars().take(24).collect::<String>()).filter(|n| !n.is_empty());
    let icon = icon.map(|i| if ICONS.contains(&i) { i } else { ICONS[0] }.to_string());
    let tone = tone.map(|t| if TONES.contains(&t) { t } else { TONES[0] }.to_string());
    (name, icon, tone)
}

async fn mine(app: &App, user_id: &str) -> Result<Vec<Sound>, ApiError> {
    Ok(app
        .db
        .query_all(&format!("SELECT {COLS} FROM sounds WHERE owner_id = ?1 ORDER BY created_at"), [user_id], from_row)
        .await?)
}

/// Atalho salvo: os ids de cada botão (os sons primeiro, na ordem; o resto vazio) e quantas linhas,
/// que seguem a quantidade de sons (1 linha a cada 3, de 1 a 3). Ids que não existem mais saem.
async fn board(app: &App, user_id: &str, sounds: &[Sound]) -> Result<(Vec<Option<String>>, i64), ApiError> {
    let saved = app
        .db
        .query_one("SELECT slots, rows FROM sound_boards WHERE user_id = ?1", [user_id], |r| {
            Ok((r.get::<String>(0)?, r.get::<i64>(1)?))
        })
        .await?;
    let slots = match saved {
        Some((slots, _)) => serde_json::from_str::<Vec<Option<String>>>(&slots).unwrap_or_default(),
        // Ainda sem atalho: começa com os primeiros sons da biblioteca.
        None => sounds.iter().take(3).map(|s| Some(s.id.clone())).collect(),
    };
    Ok(compact(slots, sounds))
}

/// Os sons do atalho em sequência (sem buracos nem repetidos), e as linhas que eles ocupam.
fn compact(slots: Vec<Option<String>>, sounds: &[Sound]) -> (Vec<Option<String>>, i64) {
    let size = (MAX_ROWS * 3) as usize;
    let mut out: Vec<Option<String>> = Vec::new();
    for id in slots.into_iter().flatten() {
        if sounds.iter().any(|s| s.id == id) && !out.contains(&Some(id.clone())) && out.len() < size {
            out.push(Some(id));
        }
    }
    let rows = (out.len() as i64 + 2) / 3;
    out.resize(size, None);
    (out, rows.clamp(MIN_ROWS, MAX_ROWS))
}

async fn library(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let sounds = mine(&app, &me.id).await?;
    let (slots, rows) = board(&app, &me.id, &sounds).await?;
    Ok(Json(json!({ "sounds": sounds, "slots": slots, "rows": rows, "max": MAX_PER_USER })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadQuery {
    #[serde(default)]
    name: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    tone: String,
    #[serde(default)]
    duration_ms: i64,
}

async fn count(app: &App, user_id: &str) -> Result<i64, ApiError> {
    Ok(app
        .db
        .query_one("SELECT COUNT(*) FROM sounds WHERE owner_id = ?1", [user_id], |r| r.get::<i64>(0))
        .await?
        .unwrap_or(0))
}

/// Põe o som novo no primeiro botão vazio do atalho (se houver).
async fn add_to_board(app: &App, user_id: &str, sound_id: &str) -> Result<(), ApiError> {
    let sounds = mine(app, user_id).await?;
    let (mut slots, _) = board(app, user_id, &sounds).await?;
    if slots.iter().any(|s| s.as_deref() == Some(sound_id)) {
        return Ok(());
    }
    if let Some(free) = slots.iter_mut().find(|s| s.is_none()) {
        *free = Some(sound_id.to_string());
        let (slots, rows) = compact(slots, &sounds);
        save_board(app, user_id, &slots, rows).await?;
    }
    Ok(())
}

async fn save_board(app: &App, user_id: &str, slots: &[Option<String>], rows: i64) -> Result<(), ApiError> {
    let slots = serde_json::to_string(slots).unwrap_or_else(|_| "[]".into());
    app.db
        .execute(
            "INSERT INTO sound_boards (user_id, slots, rows) VALUES (?1, ?2, ?3) \
             ON CONFLICT(user_id) DO UPDATE SET slots = excluded.slots, rows = excluded.rows",
            libsql::params![user_id, slots, rows],
        )
        .await?;
    Ok(())
}

async fn upload(
    State(app): AppState,
    AuthUser(me, _): AuthUser,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Sound>)> {
    if body.is_empty() || body.len() > MAX_SOUND {
        return Err(bad("O som deve ter até 1 MB"));
    }
    let mime = sniff_audio(&body).ok_or_else(|| bad("Use um áudio MP3, OGG, WAV ou M4A"))?;
    if q.duration_ms <= 0 || q.duration_ms > MAX_DURATION_MS + 250 {
        return Err(bad("O som deve ter até 5 segundos"));
    }
    if count(&app, &me.id).await? >= MAX_PER_USER {
        return Err(bad("Sua biblioteca já tem 10 sons: apague um para enviar outro"));
    }
    let (name, icon, tone) = clean_meta(Some(&q.name), Some(&q.icon), Some(&q.tone));
    let sound = Sound {
        id: uuid::Uuid::new_v4().simple().to_string(),
        owner_id: me.id.clone(),
        name: name.unwrap_or_else(|| "Som".into()),
        icon: icon.unwrap_or_default(),
        tone: tone.unwrap_or_default(),
        duration_ms: q.duration_ms.min(MAX_DURATION_MS),
        url: String::new(),
    };
    app.db
        .execute(
            "INSERT INTO sounds (id, owner_id, name, icon, tone, mime, data, duration_ms, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            libsql::params![
                sound.id.as_str(),
                me.id.as_str(),
                sound.name.as_str(),
                sound.icon.as_str(),
                sound.tone.as_str(),
                mime,
                body.to_vec(),
                sound.duration_ms,
                crate::now_ms()
            ],
        )
        .await?;
    add_to_board(&app, &me.id, &sound.id).await?;
    let url = format!("/api/sounds/{}/audio", sound.id);
    Ok((StatusCode::CREATED, Json(Sound { url, ..sound })))
}

#[derive(Deserialize)]
struct EditBody {
    name: Option<String>,
    icon: Option<String>,
    tone: Option<String>,
}

async fn edit(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>, Json(body): Json<EditBody>) -> ApiResult<Json<Sound>> {
    let (name, icon, tone) = clean_meta(body.name.as_deref(), body.icon.as_deref(), body.tone.as_deref());
    for (col, v) in [("name", name), ("icon", icon), ("tone", tone)] {
        if let Some(v) = v {
            app.db
                .execute(&format!("UPDATE sounds SET {col} = ?1 WHERE id = ?2 AND owner_id = ?3"), [v.as_str(), id.as_str(), me.id.as_str()])
                .await?;
        }
    }
    let sound = app
        .db
        .query_one(&format!("SELECT {COLS} FROM sounds WHERE id = ?1 AND owner_id = ?2"), [id.as_str(), me.id.as_str()], from_row)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Som não encontrado"))?;
    Ok(Json(sound))
}

async fn remove(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    app.db.execute("DELETE FROM sounds WHERE id = ?1 AND owner_id = ?2", [id.as_str(), me.id.as_str()]).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct BoardBody {
    slots: Vec<Option<String>>,
}

async fn set_board(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<BoardBody>) -> ApiResult<Json<Value>> {
    let sounds = mine(&app, &me.id).await?;
    // Só sons da própria biblioteca, cada um uma vez; as linhas seguem a quantidade.
    let (slots, rows) = compact(body.slots, &sounds);
    save_board(&app, &me.id, &slots, rows).await?;
    let (slots, rows) = board(&app, &me.id, &sounds).await?;
    Ok(Json(json!({ "slots": slots, "rows": rows })))
}

async fn audio(State(app): AppState, Path(id): Path<String>) -> Response {
    let row = app
        .db
        .query_one("SELECT mime, data FROM sounds WHERE id = ?1", [id.as_str()], |r| Ok((r.get::<String>(0)?, r.get::<Vec<u8>>(1)?)))
        .await;
    match row {
        Ok(Some((mime, data))) => {
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=31536000, immutable".into())], data).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Copia o som de outra pessoa para a minha biblioteca (e para o atalho, se tiver botão livre).
async fn copy(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<(StatusCode, Json<Sound>)> {
    let source = app
        .db
        .query_one(&format!("SELECT {COLS} FROM sounds WHERE id = ?1"), [id.as_str()], from_row)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Esse som não existe mais"))?;
    if source.owner_id == me.id {
        return Err(bad("Esse som já é seu"));
    }
    if count(&app, &me.id).await? >= MAX_PER_USER {
        return Err(bad("Sua biblioteca já tem 10 sons: apague um para copiar outro"));
    }
    let new_id = uuid::Uuid::new_v4().simple().to_string();
    app.db
        .execute(
            "INSERT INTO sounds (id, owner_id, name, icon, tone, mime, data, duration_ms, created_at) \
             SELECT ?1, ?2, name, icon, tone, mime, data, duration_ms, ?3 FROM sounds WHERE id = ?4",
            libsql::params![new_id.as_str(), me.id.as_str(), crate::now_ms(), id.as_str()],
        )
        .await?;
    add_to_board(&app, &me.id, &new_id).await?;
    let url = format!("/api/sounds/{new_id}/audio");
    Ok((StatusCode::CREATED, Json(Sound { id: new_id, owner_id: me.id.clone(), url, ..source })))
}

/// Sons de outra pessoa (para ouvir e copiar).
async fn of_user(State(app): AppState, AuthUser(_me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Sound>>> {
    Ok(Json(mine(&app, &id).await?))
}

/// Som da pessoa, para tocar na chamada (`sound:play`).
pub async fn owned(app: &App, user_id: &str, sound_id: &str) -> Option<Sound> {
    app.db
        .query_one(&format!("SELECT {COLS} FROM sounds WHERE id = ?1 AND owner_id = ?2"), [sound_id, user_id], from_row)
        .await
        .ok()
        .flatten()
}

/// Um administrador silenciou os sons rápidos desta pessoa no servidor?
pub async fn muted_in_guild(app: &App, guild_id: &str, user_id: &str) -> bool {
    app.db
        .query_one("SELECT sound_mutes FROM guilds WHERE id = ?1", [guild_id], |r| r.get::<String>(0))
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .is_some_and(|list| list.iter().any(|u| u == user_id))
}

/// Os sons rápidos estão ligados neste servidor?
pub async fn guild_allows(app: &App, guild_id: &str) -> bool {
    app.db
        .query_one("SELECT sounds FROM guilds WHERE id = ?1", [guild_id], |r| r.get::<i64>(0))
        .await
        .ok()
        .flatten()
        .is_none_or(|v| v != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atalho_em_sequencia_e_linhas_automaticas() {
        let snd = |id: &str| Sound {
            id: id.into(),
            owner_id: "u".into(),
            name: id.into(),
            icon: "bell".into(),
            tone: "blue".into(),
            duration_ms: 1000,
            url: String::new(),
        };
        let lib: Vec<Sound> = ["a", "b", "c", "d"].into_iter().map(snd).collect();
        let s = |v: &[Option<&str>]| v.iter().map(|x| x.map(String::from)).collect::<Vec<_>>();
        let (slots, rows) = compact(s(&[None, Some("b"), Some("x"), Some("b"), Some("a")]), &lib);
        assert_eq!(&slots[..3], &s(&[Some("b"), Some("a"), None])[..]);
        assert_eq!((slots.len(), rows), (9, 1));
        let (_, rows) = compact(s(&[Some("a"), Some("b"), Some("c"), Some("d")]), &lib);
        assert_eq!(rows, 2);
        let (_, rows) = compact(Vec::new(), &lib);
        assert_eq!(rows, 1);
    }

    #[test]
    fn reconhece_os_audios() {
        let pad = |head: &[u8]| {
            let mut v = head.to_vec();
            v.resize(32, 0);
            v
        };
        assert_eq!(sniff_audio(&pad(b"ID3\x04")), Some("audio/mpeg"));
        assert_eq!(sniff_audio(&pad(&[0xFF, 0xFB, 0x90])), Some("audio/mpeg"));
        assert_eq!(sniff_audio(&pad(b"OggS")), Some("audio/ogg"));
        assert_eq!(sniff_audio(&pad(b"RIFF\x24\0\0\0WAVEfmt ")), Some("audio/wav"));
        assert_eq!(sniff_audio(&pad(b"\0\0\0\x20ftypM4A ")), Some("audio/mp4"));
        assert_eq!(sniff_audio(&pad(b"\x89PNG\r\n\x1a\n")), None);
        assert_eq!(sniff_audio(b"curto"), None);
    }

    #[test]
    fn nome_icone_e_cor_validos() {
        let (n, i, t) = clean_meta(Some("  Buzina muito muito muito longa demais "), Some("horn"), Some("pink"));
        assert_eq!(n.as_deref(), Some("Buzina muito muito muito"));
        assert_eq!(i.as_deref(), Some("horn"));
        assert_eq!(t.as_deref(), Some("aqua"));
        assert_eq!(clean_meta(Some("   "), Some("<svg>"), None), (None, Some("horn".into()), None));
    }
}
