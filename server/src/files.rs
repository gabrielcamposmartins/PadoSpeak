//! Arquivos enviados nas conversas (imagens, vídeos, textos e o que mais for, menos executáveis).
//!
//! O conteúdo fica no disco do servidor (`<dados>/arquivos/<id>`), cifrado como as mensagens, em
//! pedaços de 64 KiB: dá para abrir só o trecho pedido (avançar no vídeo sem decifrar o arquivo todo).
//! Só baixa quem tem acesso à conversa ou ao canal onde o arquivo foi enviado.
use crate::api::{channel_with_access, ApiError, AuthUser};
use crate::auth::user_from_token;
use crate::host::App;
use crate::models::User;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

const CHUNK: usize = 64 * 1024;
/// Pedaço cifrado: nonce (12) + conteúdo + tag (16).
const SEALED_CHUNK: usize = CHUNK + 28;

/// Tamanho máximo de um arquivo (MB), ajustável por `MAX_UPLOAD_MB`.
pub fn max_bytes() -> usize {
    std::env::var("MAX_UPLOAD_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(25).clamp(1, 500) * 1024 * 1024
}

/// Extensões de programas e scripts: só entram dentro de um .zip.
const BLOCKED: &[&str] = &[
    "exe", "msi", "msp", "bat", "cmd", "com", "scr", "pif", "cpl", "msc", "ps1", "psm1", "vbs", "vbe", "js", "jse",
    "wsf", "wsh", "hta", "jar", "apk", "app", "dmg", "pkg", "deb", "rpm", "sh", "bash", "run", "bin", "lnk", "reg",
    "dll", "sys", "drv", "ocx", "appx", "msix", "appxbundle", "msixbundle", "gadget", "inf", "elf", "command", "scf",
    "url", "iso", "img", "vhd", "vhdx",
];

/// É um programa (pela extensão ou pelo conteúdo: PE do Windows, ELF do Linux, Mach-O do macOS, script)?
pub fn is_executable(name: &str, head: &[u8]) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if BLOCKED.contains(&ext.as_str()) {
        return true;
    }
    head.starts_with(b"MZ")
        || head.starts_with(b"\x7fELF")
        || head.starts_with(&[0xfe, 0xed, 0xfa, 0xce])
        || head.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
        || head.starts_with(&[0xce, 0xfa, 0xed, 0xfe])
        || head.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || head.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
        || head.starts_with(b"#!")
}

/// Tipo confirmado pelo conteúdo (para mostrar na conversa); o resto é baixado como arquivo.
fn sniff(name: &str, data: &[u8]) -> &'static str {
    if let Some(img) = crate::social::sniff_image(data) {
        return img;
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if data.len() > 12 && &data[4..8] == b"ftyp" {
        return if ext == "mov" { "video/quicktime" } else if ["m4a", "aac"].contains(&ext.as_str()) { "audio/mp4" } else { "video/mp4" };
    }
    if data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return "video/webm";
    }
    if data.starts_with(b"OggS") {
        return if ext == "ogv" { "video/ogg" } else { "audio/ogg" };
    }
    if data.starts_with(b"ID3") || (data.len() > 1 && data[0] == 0xff && data[1] & 0xe0 == 0xe0 && ext == "mp3") {
        return "audio/mpeg";
    }
    if data.starts_with(b"%PDF") {
        return "application/pdf";
    }
    if data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06") {
        return "application/zip";
    }
    // Texto: UTF-8 válido, sem bytes nulos (txt, md, log, csv, json, código…).
    let sample = &data[..data.len().min(64 * 1024)];
    let text_ext = ["txt", "md", "log", "csv", "json", "xml", "ini", "cfg", "yaml", "yml", "toml", "c", "cpp", "h", "rs", "py", "java", "ts", "css", "sql"];
    // (a amostra pode cortar um caractere no meio: isso não conta como inválido)
    let utf8 = match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    };
    if !sample.contains(&0) && (utf8 || text_ext.contains(&ext.as_str())) {
        return "text/plain";
    }
    "application/octet-stream"
}

/// Tipos que o navegador pode mostrar direto na conversa (o resto vai como download).
fn inline(mime: &str) -> bool {
    mime.starts_with("image/") || mime.starts_with("video/") || mime.starts_with("audio/") || mime == "text/plain" || mime == "application/pdf"
}

fn dir(app: &App) -> PathBuf {
    app.data_dir.join("arquivos")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/files", axum::routing::post(upload).layer(DefaultBodyLimit::max(max_bytes() + 64 * 1024)))
        .route("/api/files/{id}", get(download).delete(remove))
        .route("/api/guilds/{id}/files", get(guild_files))
}

#[derive(Deserialize)]
struct UploadQuery {
    channel: String,
    name: String,
}

/// Onde o arquivo foi enviado: canal de servidor (com a guild) ou conversa direta.
async fn place(app: &App, channel: &str, user_id: &str) -> Option<(String, Option<String>)> {
    if let Some(ch) = channel_with_access(app, channel, user_id).await {
        return Some((ch.id, Some(ch.guild_id)));
    }
    crate::social::dm_with_access(app, channel, user_id).await.map(|dm| (dm.id, None))
}

async fn upload(State(app): AppState, AuthUser(me, _): AuthUser, Query(q): Query<UploadQuery>, body: Bytes) -> ApiResult<Json<FileInfo>> {
    let bad = |m: &str| ApiError(StatusCode::BAD_REQUEST, m.into());
    let name: String = q.name.trim().replace(['/', '\\', '\0'], "_").chars().take(160).collect();
    if name.is_empty() || body.is_empty() {
        return Err(bad("Arquivo vazio"));
    }
    if body.len() > max_bytes() {
        return Err(bad(&format!("O arquivo passa de {} MB", max_bytes() / 1024 / 1024)));
    }
    if is_executable(&name, &body[..body.len().min(16)]) {
        return Err(bad("Programas e scripts não podem ser enviados. Coloque dentro de um .zip para mandar."));
    }
    let (channel_id, guild_id) = place(&app, &q.channel, &me.id).await.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversa não encontrada".into()))?;
    let mime = sniff(&name, &body);
    let id = uuid::Uuid::new_v4().simple().to_string();
    // Cifra em pedaços e grava no disco.
    let mut sealed = Vec::with_capacity(body.len() + body.len() / CHUNK * 28 + 28);
    for chunk in body.chunks(CHUNK) {
        sealed.extend_from_slice(&app.db.cipher.seal_bytes(chunk));
    }
    let folder = dir(&app);
    tokio::fs::create_dir_all(&folder).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tokio::fs::write(folder.join(&id), sealed).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    app.db
        .execute(
            "INSERT INTO files (id, owner_id, guild_id, channel_id, name, mime, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            libsql::params![id.as_str(), me.id.as_str(), guild_id, channel_id.as_str(), name.as_str(), mime, body.len() as i64, crate::now_ms()],
        )
        .await?;
    Ok(Json(FileInfo { id, name, mime: mime.into(), size: body.len() as i64 }))
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: String,
    /// `download=1`: baixa em vez de abrir.
    #[serde(default)]
    download: Option<String>,
}

struct FileRow {
    owner_id: String,
    guild_id: Option<String>,
    channel_id: String,
    name: String,
    mime: String,
    size: i64,
}

async fn file_row(app: &App, id: &str) -> Option<FileRow> {
    app.db
        .query_one("SELECT owner_id, guild_id, channel_id, name, mime, size FROM files WHERE id = ?1", [id], |r| {
            Ok(FileRow { owner_id: r.get(0)?, guild_id: r.get(1)?, channel_id: r.get(2)?, name: r.get(3)?, mime: r.get(4)?, size: r.get(5)? })
        })
        .await
        .ok()
        .flatten()
}

/// Token do cabeçalho ou da query (`<img>`, `<video>` e links não mandam cabeçalho).
async fn requester(app: &App, headers: &HeaderMap, token: &str) -> Option<User> {
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or(token);
    user_from_token(&app.db, bearer).await
}

async fn download(State(app): AppState, Path(id): Path<String>, Query(q): Query<TokenQuery>, headers: HeaderMap) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, Json(json!({ "error": "Arquivo não encontrado" }))).into_response();
    let Some(user) = requester(&app, &headers, &q.token).await else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Entre para ver o arquivo" }))).into_response();
    };
    let Some(f) = file_row(&app, &id).await else { return not_found() };
    if place(&app, &f.channel_id, &user.id).await.is_none() {
        return not_found();
    }
    let Ok(sealed) = tokio::fs::read(dir(&app).join(&id)).await else { return not_found() };
    let size = f.size as usize;
    // Trecho pedido (vídeo/áudio pedem aos pedaços para avançar e voltar).
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split(',').next())
        .and_then(|v| {
            let (a, b) = v.split_once('-')?;
            let (start, end) = match (a.trim(), b.trim()) {
                ("", suffix) => {
                    let n: usize = suffix.parse().ok()?;
                    (size.saturating_sub(n), size.saturating_sub(1))
                }
                (a, "") => (a.parse().ok()?, size.saturating_sub(1)),
                (a, b) => (a.parse().ok()?, b.parse::<usize>().ok()?.min(size.saturating_sub(1))),
            };
            (start <= end && start < size).then_some((start, end))
        });
    let (start, end) = range.unwrap_or((0, size.saturating_sub(1)));
    let mut out = Vec::with_capacity(end + 1 - start);
    if size > 0 {
        for i in start / CHUNK..=end / CHUNK {
            let piece = &sealed[(i * SEALED_CHUNK).min(sealed.len())..((i + 1) * SEALED_CHUNK).min(sealed.len())];
            let Some(plain) = app.db.cipher.open_bytes(piece) else {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Arquivo protegido com outra chave" }))).into_response();
            };
            let base = i * CHUNK;
            let from = start.max(base) - base;
            let to = (end + 1).min(base + plain.len()) - base;
            out.extend_from_slice(&plain[from..to]);
        }
    }
    let show = inline(&f.mime) && q.download.is_none();
    let encoded: String = f.name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let disposition = format!("{}; filename*=UTF-8''{encoded}", if show { "inline" } else { "attachment" });
    let mime = if f.mime == "text/plain" { "text/plain; charset=utf-8".to_string() } else if show { f.mime.clone() } else { "application/octet-stream".into() };
    let mut res = Response::new(Body::from(out));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("attachment")));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if range.is_some() {
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")) {
            res.headers_mut().insert(header::CONTENT_RANGE, v);
        }
    }
    res
}

/// Apaga um arquivo: quem enviou ou o dono do servidor onde ele está.
async fn remove(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let f = file_row(&app, &id).await.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Arquivo não encontrado".into()))?;
    let guild_owner = match &f.guild_id {
        Some(g) => app.db.query_one("SELECT owner_id FROM guilds WHERE id = ?1", [g.as_str()], |r| r.get::<String>(0)).await?,
        None => None,
    };
    if f.owner_id != me.id && guild_owner.as_deref() != Some(me.id.as_str()) {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só quem enviou ou o dono do servidor pode apagar".into()));
    }
    delete_files(&app, "SELECT id FROM files WHERE id = ?1", &id).await?;
    if let Some(g) = &f.guild_id {
        app.hub.to_guild(g, "file:deleted", json!({ "id": id }));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Apaga do disco e do banco os arquivos que a consulta (`SELECT id … ?1`) devolver.
pub async fn delete_files(app: &App, select_ids: &str, param: &str) -> Result<(), crate::api::ApiError> {
    let ids = app.db.query_all(select_ids, [param], |r| r.get::<String>(0)).await?;
    for id in &ids {
        let _ = tokio::fs::remove_file(dir(app).join(id)).await;
        app.db.execute("DELETE FROM files WHERE id = ?1", [id.as_str()]).await?;
    }
    Ok(())
}

/// Arquivos de um servidor (tela de configuração, só o dono).
async fn guild_files(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let owner = app.db.query_one("SELECT owner_id FROM guilds WHERE id = ?1", [id.as_str()], |r| r.get::<String>(0)).await?;
    if owner.as_deref() != Some(me.id.as_str()) {
        return Err(ApiError(StatusCode::NOT_FOUND, "Servidor não encontrado".into()));
    }
    let list = app
        .db
        .query_all(
            "SELECT f.id, f.name, f.mime, f.size, f.created_at, f.channel_id, COALESCE(c.name, ''), u.display_name, u.username \
             FROM files f LEFT JOIN channels c ON c.id = f.channel_id JOIN users u ON u.id = f.owner_id \
             WHERE f.guild_id = ?1 ORDER BY f.created_at DESC",
            [id.as_str()],
            |r| {
                Ok(json!({
                    "id": r.get::<String>(0)?, "name": r.get::<String>(1)?, "mime": r.get::<String>(2)?,
                    "size": r.get::<i64>(3)?, "createdAt": r.get::<i64>(4)?, "channelId": r.get::<String>(5)?,
                    "channelName": r.get::<String>(6)?, "by": r.get::<String>(7)?, "byUsername": r.get::<String>(8)?,
                }))
            },
        )
        .await?;
    let total: i64 = list.iter().filter_map(|f| f["size"].as_i64()).sum();
    Ok(Json(json!({ "files": list, "total": total, "maxFile": max_bytes() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bloqueia_programas_mas_aceita_zip() {
        assert!(is_executable("setup.exe", b"MZ\x90\x00"));
        assert!(is_executable("foto.png", b"MZ\x90\x00"), "programa disfarçado de imagem");
        assert!(is_executable("script.ps1", b"Write-Host"));
        assert!(is_executable("rodar", b"\x7fELF\x02"));
        assert!(!is_executable("pacote.zip", b"PK\x03\x04"));
        assert!(!is_executable("notas.txt", b"ola mundo"));
        assert_eq!(sniff("a.zip", b"PK\x03\x04restante"), "application/zip");
        assert_eq!(sniff("notas.txt", "olá, tudo bem?".as_bytes()), "text/plain");
        assert_eq!(sniff("v.mp4", b"\x00\x00\x00\x18ftypmp42\x00\x00"), "video/mp4");
        assert_eq!(sniff("x.bin", &[0u8, 1, 2, 3]), "application/octet-stream");
        assert!(!inline("application/zip"));
    }
}
