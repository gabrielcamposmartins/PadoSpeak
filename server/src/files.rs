//! Arquivos enviados nas conversas (imagens, vídeos, textos e o que mais for, menos executáveis).
//!
//! O conteúdo fica no disco do servidor (`<dados>/arquivos/<id>`), cifrado como as mensagens, em
//! pedaços de 64 KiB: dá para abrir só o trecho pedido (avançar no vídeo sem decifrar o arquivo todo).
//! Só baixa quem tem acesso à conversa ou ao canal onde o arquivo foi enviado. O nome do arquivo
//! também fica cifrado no banco.
//!
//! NSFW: quem envia pode marcar o arquivo (`nsfw=1`); a mensagem leva o tipo como `nsfw;<tipo>` e o
//! app mostra a imagem/vídeo borrado até a pessoa clicar.
//!
//! Compressão: o app já manda texto, documentos e afins comprimidos em gzip (`encoding=gzip`); o que
//! chegar sem compressão e valer a pena é comprimido aqui. O disco guarda o gzip, e o download vai com
//! `Content-Encoding: gzip` — o navegador descomprime sozinho ao receber. Imagens, vídeos, áudios e
//! compactados já vêm comprimidos e ficam como estão (e mantêm o avanço por trechos).
//!
//! Validade: cada servidor escolhe quanto tempo os arquivos e as mensagens de voz novas ficam
//! (`guilds.file_ttl_ms` / `voice_ttl_ms`), e os administradores mudam a de cada arquivo. Arquivos
//! maiores que o limite normal entram como "grandes": ficam só 10 minutos, no máximo 3 de cada vez e
//! somando até 3 GB. Ao expirar, o arquivo e a mensagem que o mostrava somem.
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
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

const CHUNK: usize = 64 * 1024;
/// Pedaço cifrado: nonce (12) + conteúdo + tag (16).
const SEALED_CHUNK: usize = CHUNK + 28;

/// Tamanho máximo de um arquivo (MB), ajustável por `MAX_UPLOAD_MB`.
pub fn max_bytes() -> usize {
    std::env::var("MAX_UPLOAD_MB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(25).clamp(1, 500) * 1024 * 1024
}

/// Arquivos grandes (acima de `max_bytes`): validade fixa, quantos de cada vez e quanto somam.
pub const BIG_TTL_MS: i64 = 10 * 60 * 1000;
pub const BIG_MAX_COUNT: usize = 3;
pub const BIG_MAX_TOTAL: u64 = 3 * 1024 * 1024 * 1024;
/// Espaço que sempre fica livre no disco (o banco e o sistema precisam).
const DISK_RESERVE: u64 = 512 * 1024 * 1024;
/// Mensagem de voz: até 20 MB (uns 10 minutos de Opus).
const VOICE_MAX: usize = 20 * 1024 * 1024;

/// Envios grandes em andamento (id → tamanho declarado): contam no limite antes de terminar.
static BIG_UPLOADS: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

/// Limites que o app mostra antes de enviar.
pub fn limits() -> Value {
    json!({ "maxFile": max_bytes(), "bigTtlMs": BIG_TTL_MS, "bigMaxCount": BIG_MAX_COUNT, "bigMaxTotal": BIG_MAX_TOTAL })
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
        return if ext == "weba" { "audio/webm" } else { "video/webm" };
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

/// Mensagem de voz: o contêiner (WebM/MP4/Ogg) vale como áudio.
fn voice_mime(sniffed: &'static str) -> Option<&'static str> {
    match sniffed {
        "video/webm" | "audio/webm" => Some("audio/webm"),
        "video/mp4" | "audio/mp4" => Some("audio/mp4"),
        "audio/ogg" | "video/ogg" => Some("audio/ogg"),
        "audio/mpeg" => Some("audio/mpeg"),
        _ => None,
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub big: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub nsfw: bool,
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        // O limite é conferido aos poucos enquanto o arquivo chega (grandes vão direto para o disco).
        .route("/api/files", axum::routing::post(upload).layer(DefaultBodyLimit::disable()))
        .route("/api/files/{id}", get(download).delete(remove).patch(set_ttl))
        .route("/api/guilds/{id}/files", get(guild_files))
}

#[derive(Deserialize)]
struct UploadQuery {
    channel: String,
    name: String,
    /// `gzip`: o corpo vem comprimido pelo app.
    #[serde(default)]
    encoding: Option<String>,
    /// `voice`: mensagem de voz gravada no app.
    #[serde(default)]
    kind: Option<String>,
    /// `1`: marcado como NSFW (aparece borrado até clicar).
    #[serde(default)]
    nsfw: Option<String>,
}

impl UploadQuery {
    fn nsfw(&self) -> bool {
        matches!(self.nsfw.as_deref(), Some("1" | "true"))
    }
}

/// Formatos que já são comprimidos: comprimir de novo só gasta CPU.
fn compressible(mime: &str, name: &str) -> bool {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let packed = [
        "zip", "rar", "7z", "gz", "tgz", "bz2", "xz", "zst", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "jar",
        "apk", "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "mp3", "mp4", "m4a", "aac", "ogg", "opus", "webm",
        "mkv", "mov", "avi", "flac", "woff", "woff2",
    ];
    !(mime.starts_with("image/") || mime.starts_with("video/") || mime.starts_with("audio/") || mime == "application/zip")
        && !packed.contains(&ext.as_str())
}

/// Descomprime um gzip sem deixar passar de `limit` bytes (proteção contra "bomba" de compressão).
fn gunzip_limited(data: &[u8], limit: usize) -> Result<Vec<u8>, &'static str> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data)
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| "Arquivo comprimido inválido")?;
    if out.len() > limit {
        return Err("too_big");
    }
    Ok(out)
}

fn gzip(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(data.len() / 3), flate2::Compression::new(6));
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

/// Onde o arquivo foi enviado: canal de servidor (com a guild) ou conversa direta.
async fn place(app: &App, channel: &str, user_id: &str) -> Option<(String, Option<String>)> {
    if let Some(ch) = channel_with_access(app, channel, user_id).await {
        return Some((ch.id, Some(ch.guild_id)));
    }
    crate::social::dm_with_access(app, channel, user_id).await.map(|dm| (dm.id, None))
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// Lê o corpo inteiro na memória, sem passar de `limit` bytes.
async fn collect_limited(body: Body, limit: usize) -> Result<Option<Bytes>, ApiError> {
    let mut stream = body.into_data_stream();
    let mut buf = Vec::new();
    while let Some(piece) = stream.next().await {
        let piece = piece.map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("Envio interrompido: {e}")))?;
        if buf.len() + piece.len() > limit {
            return Ok(None);
        }
        buf.extend_from_slice(&piece);
    }
    Ok(Some(Bytes::from(buf)))
}

/// Validade padrão do servidor para arquivos (`kind` = None) ou mensagens de voz.
async fn guild_ttl(app: &App, guild_id: &str, voice: bool) -> Option<i64> {
    let col = if voice { "voice_ttl_ms" } else { "file_ttl_ms" };
    app.db
        .query_one(&format!("SELECT {col} FROM guilds WHERE id = ?1"), [guild_id], |r| r.get::<Option<i64>>(0))
        .await
        .ok()
        .flatten()
        .flatten()
}

/// Arquivos grandes guardados agora (quantos e quanto somam) — sem contar os que estão chegando.
async fn big_usage(app: &App) -> (usize, u64) {
    app.db
        .query_one("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files WHERE big = 1", (), |r| {
            Ok((r.get::<i64>(0)? as usize, r.get::<i64>(1)? as u64))
        })
        .await
        .ok()
        .flatten()
        .unwrap_or((0, 0))
}

/// Libera a vaga do envio grande quando ele termina (bem ou mal).
struct BigSlot(String);
impl Drop for BigSlot {
    fn drop(&mut self) {
        BIG_UPLOADS.lock().unwrap().retain(|(id, _)| id != &self.0);
    }
}

/// Reserva uma vaga para um arquivo grande de `size` bytes, ou diz por que não dá.
async fn reserve_big(app: &App, id: &str, size: u64) -> Result<BigSlot, ApiError> {
    let gb = |b: u64| format!("{:.1} GB", b as f64 / 1024.0 / 1024.0 / 1024.0);
    let refuse = |m: String| ApiError(StatusCode::PAYLOAD_TOO_LARGE, m);
    if size > BIG_MAX_TOTAL {
        return Err(refuse(format!("O arquivo passa de {}", gb(BIG_MAX_TOTAL))));
    }
    let (count, total) = big_usage(app).await;
    let folder = dir(app);
    let _ = tokio::fs::create_dir_all(&folder).await;
    let free = fs4::available_space(&folder).unwrap_or(u64::MAX);
    let mut list = BIG_UPLOADS.lock().unwrap();
    let count = count + list.len();
    let total = total + list.iter().map(|(_, s)| s).sum::<u64>();
    let pending: u64 = list.iter().map(|(_, s)| s).sum();
    if count >= BIG_MAX_COUNT {
        return Err(refuse(format!(
            "Já há {BIG_MAX_COUNT} arquivos grandes no servidor. Eles somem 10 minutos depois de enviados; tente daqui a pouco."
        )));
    }
    if total + size > BIG_MAX_TOTAL {
        return Err(refuse(format!(
            "Os arquivos grandes no servidor somariam mais de {} (já há {} ocupados). Tente daqui a pouco.",
            gb(BIG_MAX_TOTAL),
            gb(total)
        )));
    }
    if free < size + pending + DISK_RESERVE {
        return Err(refuse(format!("O servidor está sem espaço para este arquivo (livre: {})", gb(free.saturating_sub(DISK_RESERVE)))));
    }
    list.push((id.to_string(), size));
    Ok(BigSlot(id.to_string()))
}

/// Grava pedaços cifrados no disco enquanto o arquivo chega (para os grandes, que não cabem na memória).
struct SealedWriter {
    file: tokio::io::BufWriter<tokio::fs::File>,
    pending: Vec<u8>,
}

impl SealedWriter {
    async fn push(&mut self, app: &App, data: &[u8]) -> std::io::Result<()> {
        self.pending.extend_from_slice(data);
        while self.pending.len() >= CHUNK {
            let rest = self.pending.split_off(CHUNK);
            let sealed = app.db.cipher.seal_bytes(&self.pending);
            self.file.write_all(&sealed).await?;
            self.pending = rest;
        }
        Ok(())
    }
    async fn finish(mut self, app: &App) -> std::io::Result<()> {
        if !self.pending.is_empty() {
            let sealed = app.db.cipher.seal_bytes(&self.pending);
            self.file.write_all(&sealed).await?;
        }
        self.file.flush().await?;
        self.file.into_inner().sync_all().await
    }
}

async fn upload(
    State(app): AppState,
    AuthUser(me, _): AuthUser,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<FileInfo>> {
    let bad = |m: &str| ApiError(StatusCode::BAD_REQUEST, m.into());
    let name: String = q.name.trim().replace(['/', '\\', '\0'], "_").chars().take(160).collect();
    if name.is_empty() {
        return Err(bad("Arquivo vazio"));
    }
    let voice = q.kind.as_deref() == Some("voice");
    let nsfw = q.nsfw() && !voice;
    let (channel_id, guild_id) =
        place(&app, &q.channel, &me.id).await.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversa não encontrada".into()))?;
    let declared: Option<u64> =
        headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let sent_gzip = q.encoding.as_deref() == Some("gzip");
    let limit = if voice { VOICE_MAX } else { max_bytes() };
    if declared.is_some_and(|n| n as usize > limit) && !voice && !sent_gzip {
        return upload_big(&app, &me, name, channel_id, guild_id, declared.unwrap_or_default(), nsfw, body).await;
    }
    let too_big = || {
        if voice {
            bad("A mensagem de voz ficou grande demais")
        } else {
            bad(&format!("O arquivo passa de {} MB", max_bytes() / 1024 / 1024))
        }
    };
    let packed_body = collect_limited(body, limit).await?.ok_or_else(too_big)?;
    // Veio comprimido: abre para conferir o conteúdo e o tamanho de verdade.
    let body: Bytes = if sent_gzip {
        let packed = packed_body.clone();
        let raw = tokio::task::spawn_blocking(move || gunzip_limited(&packed, limit)).await.map_err(internal)?;
        match raw {
            Ok(raw) => Bytes::from(raw),
            Err("too_big") => return Err(too_big()),
            Err(e) => return Err(bad(e)),
        }
    } else {
        packed_body.clone()
    };
    if body.is_empty() {
        return Err(bad("Arquivo vazio"));
    }
    if is_executable(&name, &body[..body.len().min(16)]) {
        return Err(bad("Programas e scripts não podem ser enviados. Coloque dentro de um .zip para mandar."));
    }
    let mut mime = sniff(&name, &body);
    if voice {
        mime = voice_mime(mime).ok_or_else(|| bad("Gravação de áudio inválida"))?;
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    // Guarda comprimido quando economiza pelo menos 10%.
    let stored: Option<Bytes> = if compressible(mime, &name) {
        let packed = if sent_gzip {
            Some(packed_body)
        } else {
            let raw = body.clone();
            tokio::task::spawn_blocking(move || Bytes::from(gzip(&raw))).await.ok()
        };
        packed.filter(|p| p.len() * 10 < body.len() * 9)
    } else {
        None
    };
    let encoding = stored.as_ref().map(|_| "gzip");
    let content = stored.as_ref().unwrap_or(&body);
    // Cifra em pedaços e grava no disco.
    let mut sealed = Vec::with_capacity(content.len() + content.len() / CHUNK * 28 + 28);
    for chunk in content.chunks(CHUNK) {
        sealed.extend_from_slice(&app.db.cipher.seal_bytes(chunk));
    }
    let folder = dir(&app);
    tokio::fs::create_dir_all(&folder).await.map_err(internal)?;
    tokio::fs::write(folder.join(&id), sealed).await.map_err(internal)?;
    let now = crate::now_ms();
    let ttl = match &guild_id {
        Some(g) => guild_ttl(&app, g, voice).await,
        None => None,
    };
    let expires_at = ttl.map(|t| now + t);
    app.db
        .execute(
            "INSERT INTO files (id, owner_id, guild_id, channel_id, name, mime, size, created_at, encoding, stored, expires_at, kind, nsfw) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            libsql::params![
                id.as_str(),
                me.id.as_str(),
                guild_id,
                channel_id.as_str(),
                app.db.cipher.seal(&name),
                mime,
                body.len() as i64,
                now,
                encoding,
                content.len() as i64,
                expires_at,
                voice.then_some("voice"),
                nsfw as i64
            ],
        )
        .await?;
    Ok(Json(FileInfo { id, name, mime: mime.into(), size: body.len() as i64, expires_at, big: false, nsfw }))
}

/// Arquivo maior que o limite normal: vai direto para o disco aos poucos e some em 10 minutos.
async fn upload_big(
    app: &Arc<App>,
    me: &User,
    name: String,
    channel_id: String,
    guild_id: Option<String>,
    size: u64,
    nsfw: bool,
    body: Body,
) -> ApiResult<Json<FileInfo>> {
    let bad = |m: &str| ApiError(StatusCode::BAD_REQUEST, m.into());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let _slot = reserve_big(app, &id, size).await?;
    let folder = dir(app);
    let part = folder.join(format!("{id}.part"));
    let file = tokio::fs::File::create(&part).await.map_err(internal)?;
    let mut writer = SealedWriter { file: tokio::io::BufWriter::with_capacity(4 * SEALED_CHUNK, file), pending: Vec::new() };
    let mut stream = body.into_data_stream();
    let mut head: Vec<u8> = Vec::new();
    let mut received: u64 = 0;
    let mut mime = "application/octet-stream";
    let result: Result<(), ApiError> = async {
        while let Some(piece) = stream.next().await {
            let piece = piece.map_err(|e| bad(&format!("Envio interrompido: {e}")))?;
            received += piece.len() as u64;
            if received > size {
                return Err(bad("O arquivo é maior do que o informado"));
            }
            // O começo decide o tipo e barra programas antes de gravar o resto.
            if head.len() < CHUNK {
                head.extend_from_slice(&piece[..piece.len().min(CHUNK - head.len())]);
                if head.len() >= CHUNK.min(size as usize) {
                    if is_executable(&name, &head[..head.len().min(16)]) {
                        return Err(bad("Programas e scripts não podem ser enviados. Coloque dentro de um .zip para mandar."));
                    }
                    mime = sniff(&name, &head);
                }
            }
            writer.push(app, &piece).await.map_err(internal)?;
        }
        if received != size {
            return Err(bad("O envio parou no meio"));
        }
        writer.finish(app).await.map_err(internal)?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&part).await;
        // Lê (e descarta) um pouco do resto antes de responder: se a conexão fechar com o envio
        // ainda chegando, o app vê "conexão caiu" em vez da mensagem do erro.
        let mut drained = 0usize;
        while drained < 32 * 1024 * 1024 {
            match stream.next().await {
                Some(Ok(piece)) => drained += piece.len(),
                _ => break,
            }
        }
        return Err(e);
    }
    tokio::fs::rename(&part, folder.join(&id)).await.map_err(internal)?;
    let now = crate::now_ms();
    let expires_at = now + BIG_TTL_MS;
    app.db
        .execute(
            "INSERT INTO files (id, owner_id, guild_id, channel_id, name, mime, size, created_at, encoding, stored, expires_at, big, nsfw) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?7, ?9, 1, ?10)",
            libsql::params![
                id.as_str(),
                me.id.as_str(),
                guild_id,
                channel_id.as_str(),
                app.db.cipher.seal(&name),
                mime,
                size as i64,
                now,
                expires_at,
                nsfw as i64
            ],
        )
        .await?;
    app.logs.info(format!("Arquivo grande recebido: {name} ({} MB, some em 10 min)", size / 1024 / 1024));
    Ok(Json(FileInfo { id, name, mime: mime.into(), size: size as i64, expires_at: Some(expires_at), big: true, nsfw }))
}

/// A mensagem `[arquivo:…]`/`[voz:…]` acabou de ser enviada: o arquivo passa a ser dela (some junto
/// quando expirar). Devolve quando ela expira, se expirar.
pub async fn link_message(app: &App, content: &str, channel_id: &str, user_id: &str, message_id: &str) -> Option<i64> {
    let file_id = crate::models::message_file_id(content)?;
    app.db
        .execute(
            "UPDATE files SET message_id = ?1 WHERE id = ?2 AND owner_id = ?3 AND channel_id = ?4 AND message_id IS NULL",
            [message_id, file_id, user_id, channel_id],
        )
        .await
        .ok()?;
    app.db
        .query_one("SELECT expires_at FROM files WHERE id = ?1 AND message_id = ?2", [file_id, message_id], |r| r.get::<Option<i64>>(0))
        .await
        .ok()
        .flatten()
        .flatten()
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
    encoding: Option<String>,
    big: bool,
    message_id: Option<String>,
}

async fn file_row(app: &App, id: &str) -> Option<FileRow> {
    app.db
        .query_one(
            "SELECT owner_id, guild_id, channel_id, name, mime, size, encoding, big, message_id FROM files WHERE id = ?1",
            [id],
            |r| {
                Ok(FileRow {
                    owner_id: r.get(0)?,
                    guild_id: r.get(1)?,
                    channel_id: r.get(2)?,
                    name: app.db.cipher.reveal(&r.get::<String>(3)?),
                    mime: r.get(4)?,
                    size: r.get(5)?,
                    encoding: r.get(6)?,
                    big: r.get::<i64>(7)? != 0,
                    message_id: r.get(8)?,
                })
            },
        )
        .await
        .ok()
        .flatten()
}

/// Token do cabeçalho ou da query (`<img>`, `<video>` e links não mandam cabeçalho).
async fn requester(app: &App, headers: &HeaderMap, token: &str) -> Option<User> {
    let bearer = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or(token);
    user_from_token(&app.db, bearer).await
}

/// Lê e decifra o pedaço `i` do arquivo aberto.
async fn read_piece(app: &App, file: &mut tokio::fs::File, i: usize) -> std::io::Result<Vec<u8>> {
    file.seek(std::io::SeekFrom::Start((i * SEALED_CHUNK) as u64)).await?;
    let mut buf = vec![0u8; SEALED_CHUNK];
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    app.db.cipher.open_bytes(&buf).ok_or_else(|| std::io::Error::other("Arquivo protegido com outra chave"))
}

async fn download(State(app): AppState, Path(id): Path<String>, Query(q): Query<TokenQuery>, headers: HeaderMap) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, Json(json!({ "error": "Arquivo não encontrado" }))).into_response();
    let Some(user) = requester(&app, &headers, &q.token).await else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Entre para ver o arquivo" }))).into_response();
    };
    let Some(f) = file_row(&app, &id).await else { return not_found() };
    // O painel do administrador do app abre os arquivos dos servidores (não os das conversas diretas).
    if place(&app, &f.channel_id, &user.id).await.is_none() && !(f.guild_id.is_some() && crate::admin::can_view(&app, &user).await) {
        return not_found();
    }
    let path = dir(&app).join(&id);
    if f.encoding.as_deref() == Some("gzip") {
        let Ok(sealed) = tokio::fs::read(&path).await else { return not_found() };
        return download_gzip(&app, &f, &sealed, &q, &headers);
    }
    let Ok(mut file) = tokio::fs::File::open(&path).await else { return not_found() };
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
    // O primeiro pedaço é lido antes: se a chave não abrir o arquivo, dá para avisar com um erro.
    let first = if size > 0 {
        match read_piece(&app, &mut file, start / CHUNK).await {
            Ok(p) => Some(p),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
        }
    } else {
        None
    };
    // O resto vai saindo aos poucos (um arquivo de 3 GB não cabe na memória).
    let last = end / CHUNK;
    let slice = move |i: usize, plain: Vec<u8>| -> Bytes {
        let base = i * CHUNK;
        let from = start.max(base) - base;
        let to = ((end + 1).min(base + plain.len()) - base).max(from);
        Bytes::copy_from_slice(&plain[from..to])
    };
    let app2 = app.clone();
    let stream = futures_util::stream::unfold((first, start / CHUNK, file), move |(first, i, mut file)| {
        let app = app2.clone();
        async move {
            if size == 0 || i > last {
                return None;
            }
            let piece = match first {
                Some(p) => Ok(p),
                None => read_piece(&app, &mut file, i).await,
            };
            Some((piece.map(|p| slice(i, p)), (None, i + 1, file)))
        }
    });
    let mut res = Response::new(Body::from_stream(stream));
    file_headers(&mut res, &f, &q);
    let h = res.headers_mut();
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(v) = HeaderValue::from_str(&(if size == 0 { 0 } else { end + 1 - start }).to_string()) {
        h.insert(header::CONTENT_LENGTH, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(if f.big { "private, no-store" } else { "private, max-age=86400" }));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if range.is_some() {
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")) {
            res.headers_mut().insert(header::CONTENT_RANGE, v);
        }
    }
    res
}

/// Tipo e nome do arquivo (abrir na conversa ou baixar).
fn file_headers(res: &mut Response, f: &FileRow, q: &TokenQuery) {
    let show = inline(&f.mime) && q.download.is_none();
    let encoded: String = f
        .name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let disposition = format!("{}; filename*=UTF-8''{encoded}", if show { "inline" } else { "attachment" });
    let mime = if f.mime == "text/plain" {
        "text/plain; charset=utf-8".to_string()
    } else if show {
        f.mime.clone()
    } else {
        "application/octet-stream".into()
    };
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("attachment")));
}

/// Arquivo guardado em gzip: vai comprimido (`Content-Encoding`) e o navegador descomprime ao receber.
/// Quem não aceita gzip recebe descomprimido. Sem trechos (Range): sempre o arquivo inteiro.
fn download_gzip(app: &App, f: &FileRow, sealed: &[u8], q: &TokenQuery, headers: &HeaderMap) -> Response {
    let mut packed = Vec::with_capacity(sealed.len());
    for piece in sealed.chunks(SEALED_CHUNK) {
        let Some(plain) = app.db.cipher.open_bytes(piece) else {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Arquivo protegido com outra chave" }))).into_response();
        };
        packed.extend_from_slice(&plain);
    }
    let accepts = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().split(';').next() == Some("gzip")));
    let body = if accepts {
        packed
    } else {
        match gunzip_limited(&packed, f.size.max(0) as usize) {
            Ok(raw) => raw,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Arquivo corrompido" }))).into_response(),
        }
    };
    let mut res = Response::new(Body::from(body));
    file_headers(&mut res, f, q);
    let h = res.headers_mut();
    if accepts {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("none"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    res
}

/// Administrador do servidor do arquivo?
async fn guild_admin(app: &App, guild_id: &Option<String>, user_id: &str) -> Result<bool, ApiError> {
    Ok(match guild_id {
        Some(g) => crate::api::member_perms(app, g, user_id).await?.is_some_and(|p| crate::api::perm::has(p, crate::api::perm::ADMIN)),
        None => false,
    })
}

/// Apaga um arquivo: quem enviou ou o dono do servidor onde ele está.
async fn remove(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let f = file_row(&app, &id).await.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Arquivo não encontrado".into()))?;
    if f.owner_id != me.id && !guild_admin(&app, &f.guild_id, &me.id).await? {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só quem enviou ou um administrador do servidor pode apagar".into()));
    }
    delete_files(&app, "SELECT id FROM files WHERE id = ?1", &id).await?;
    if let Some(g) = &f.guild_id {
        app.hub.to_guild(g, "file:deleted", json!({ "id": id }));
        app.audit(crate::audit::Entry::new(g, "settings.file_delete", &me.id).channel(&f.channel_id).target(&f.owner_id).detail(json!({ "name": f.name })));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TtlBody {
    /// ms a partir de agora; `null` = não expira.
    #[serde(default)]
    ttl_ms: Value,
}

/// Muda a validade de um arquivo (administradores do servidor; numa conversa direta, quem enviou).
/// Arquivos grandes têm validade fixa.
async fn set_ttl(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>, Json(body): Json<TtlBody>) -> ApiResult<Json<Value>> {
    let f = file_row(&app, &id).await.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Arquivo não encontrado".into()))?;
    let allowed = match &f.guild_id {
        Some(_) => guild_admin(&app, &f.guild_id, &me.id).await?,
        None => f.owner_id == me.id,
    };
    if !allowed {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só administradores mudam a validade dos arquivos".into()));
    }
    if f.big {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Arquivos grandes sempre somem 10 minutos depois de enviados".into()));
    }
    let expires_at = crate::api::parse_ttl(&body.ttl_ms)?.map(|t| crate::now_ms() + t);
    app.db.execute("UPDATE files SET expires_at = ?1 WHERE id = ?2", libsql::params![expires_at, id.as_str()]).await?;
    if let Some(g) = &f.guild_id {
        app.audit(crate::audit::Entry::new(g, "settings.file_ttl", &me.id).channel(&f.channel_id).detail(json!({ "name": f.name, "expiresAt": expires_at })));
    }
    if let Some(message_id) = &f.message_id {
        let d = json!({ "id": message_id, "channelId": f.channel_id, "expiresAt": expires_at });
        match &f.guild_id {
            Some(g) => app.hub.to_channel(g, &f.channel_id, "message:expires", d),
            None => {
                if let Some(dm) = crate::social::dm_by_id(&app, &f.channel_id).await {
                    app.hub.to_users(&dm.users(), "message:expires", d);
                }
            }
        }
    }
    Ok(Json(json!({ "expiresAt": expires_at })))
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

/// A mensagem apagada era um arquivo enviado naquela conversa/canal: o arquivo vai junto.
pub async fn delete_message_file(app: &App, sealed_content: &str, channel_id: &str) {
    let content = app.db.cipher.reveal(sealed_content);
    let Some(id) = crate::models::message_file_id(&content) else { return };
    if file_row(app, id).await.is_some_and(|f| f.channel_id == channel_id) {
        let _ = delete_files(app, "SELECT id FROM files WHERE id = ?1", id).await;
    }
}

/// Apaga os arquivos vencidos e as mensagens que os mostravam (a cada 20 s). Ao subir, limpa
/// também os envios grandes que ficaram pela metade.
pub fn spawn_sweeper(app: Arc<App>) {
    tokio::spawn(async move {
        if let Ok(mut entries) = tokio::fs::read_dir(dir(&app)).await {
            while let Ok(Some(e)) = entries.next_entry().await {
                if e.file_name().to_string_lossy().ends_with(".part") {
                    let _ = tokio::fs::remove_file(e.path()).await;
                }
            }
        }
        let shutdown = app.hub.shutdown.clone();
        loop {
            sweep(&app).await;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(20)) => {}
                _ = shutdown.cancelled() => break,
            }
        }
    });
}

async fn sweep(app: &App) {
    let due = app
        .db
        .query_all(
            "SELECT id, guild_id, channel_id, message_id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?1 LIMIT 200",
            [crate::now_ms()],
            |r| Ok((r.get::<String>(0)?, r.get::<Option<String>>(1)?, r.get::<String>(2)?, r.get::<Option<String>>(3)?)),
        )
        .await
        .unwrap_or_default();
    for (id, guild_id, channel_id, message_id) in due {
        let _ = tokio::fs::remove_file(dir(app).join(&id)).await;
        let _ = app.db.execute("DELETE FROM files WHERE id = ?1", [id.as_str()]).await;
        let Some(message_id) = message_id else { continue };
        let _ = app.db.execute("DELETE FROM message_reactions WHERE message_id = ?1", [message_id.as_str()]).await;
        let gone = json!({ "id": message_id, "channelId": channel_id });
        match &guild_id {
            Some(g) => {
                let _ = app.db.execute("DELETE FROM messages WHERE id = ?1", [message_id.as_str()]).await;
                app.hub.to_channel(g, &channel_id, "message:deleted", gone);
            }
            None => {
                let _ = app.db.execute("DELETE FROM dm_messages WHERE id = ?1", [message_id.as_str()]).await;
                if let Some(dm) = crate::social::dm_by_id(app, &channel_id).await {
                    app.hub.to_users(&dm.users(), "message:deleted", gone);
                }
            }
        }
    }
}

/// Arquivos de um servidor (tela de configuração, administradores).
async fn guild_files(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let perms = crate::api::member_perms(&app, &id, &me.id).await?;
    if !perms.is_some_and(|p| crate::api::perm::has(p, crate::api::perm::ADMIN)) {
        return Err(ApiError(StatusCode::NOT_FOUND, "Servidor não encontrado".into()));
    }
    Ok(Json(guild_file_list(&app, &id).await?))
}

/// Lista dos arquivos de um servidor, com o total guardado e os limites.
pub async fn guild_file_list(app: &App, id: &str) -> ApiResult<Value> {
    let list = app
        .db
        .query_all(
            "SELECT f.id, f.name, f.mime, f.size, f.created_at, f.channel_id, COALESCE(c.name, ''), u.display_name, u.username, \
             COALESCE(f.stored, f.size), f.expires_at, f.big, f.kind, f.nsfw FROM files f LEFT JOIN channels c ON c.id = f.channel_id \
             JOIN users u ON u.id = f.owner_id WHERE f.guild_id = ?1 ORDER BY f.created_at DESC",
            [id],
            |r| {
                Ok(json!({
                    "id": r.get::<String>(0)?, "name": app.db.cipher.reveal(&r.get::<String>(1)?), "mime": r.get::<String>(2)?,
                    "size": r.get::<i64>(3)?, "createdAt": r.get::<i64>(4)?, "channelId": r.get::<String>(5)?,
                    "channelName": r.get::<String>(6)?, "by": r.get::<String>(7)?, "byUsername": r.get::<String>(8)?,
                    "stored": r.get::<i64>(9)?, "expiresAt": r.get::<Option<i64>>(10)?, "big": r.get::<i64>(11)? != 0,
                    "kind": r.get::<Option<String>>(12)?, "nsfw": r.get::<i64>(13)? != 0,
                }))
            },
        )
        .await?;
    let total: i64 = list.iter().filter_map(|f| f["size"].as_i64()).sum();
    let stored: i64 = list.iter().filter_map(|f| f["stored"].as_i64()).sum();
    let (big_count, big_total) = big_usage(app).await;
    Ok(json!({
        "files": list, "total": total, "stored": stored, "maxFile": max_bytes(),
        "big": { "count": big_count, "total": big_total, "maxCount": BIG_MAX_COUNT, "maxTotal": BIG_MAX_TOTAL, "ttlMs": BIG_TTL_MS },
    }))
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

    #[test]
    fn audio_de_voz() {
        assert_eq!(voice_mime(sniff("voz.webm", &[0x1a, 0x45, 0xdf, 0xa3, 0, 0])), Some("audio/webm"));
        assert_eq!(voice_mime(sniff("voz.m4a", b"\x00\x00\x00\x18ftypM4A \x00\x00")), Some("audio/mp4"));
        assert_eq!(voice_mime(sniff("voz.txt", b"nada de audio")), None);
    }

    #[test]
    fn comprime_e_barra_bomba() {
        let texto = "linha de log repetida
".repeat(5000);
        let gz = gzip(texto.as_bytes());
        assert!(gz.len() * 10 < texto.len(), "texto repetido deve comprimir bem");
        assert_eq!(gunzip_limited(&gz, texto.len()).unwrap(), texto.as_bytes());
        assert_eq!(gunzip_limited(&gz, texto.len() - 1), Err("too_big"));
        assert!(gunzip_limited(b"nao e gzip", 1000).is_err());
        assert!(compressible("text/plain", "notas.txt"));
        assert!(!compressible("image/png", "foto.png"));
        assert!(!compressible("application/octet-stream", "planilha.xlsx"));
    }
}
