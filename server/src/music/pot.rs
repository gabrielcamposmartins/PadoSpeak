//! Token do YouTube (PO token) para o yt-dlp, pedido ao nó de mídia a cada música.
//!
//! O yt-dlp ganha o plugin bgutil (`bgutil-ytdlp-pot-provider`, versão fixa) e pede o token a um provedor
//! no laço local deste processo (`start_shim`), que repassa o pedido ao nó com token (`crate::media`). O nó
//! gera o token no bgutil que ele supervisiona (`crate::media::pot`), da rede dele.
//!
//! Sem nó de token (nem `POT_PROVIDER_URL`), o yt-dlp roda como antes, sem o plugin.
use crate::host::App;
use crate::logs::Logs;
use crate::media::registry::Registry;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// A versão do plugin precisa ser a mesma do servidor bgutil do nó (`crate::media::pot`).
pub const PLUGIN_VERSION: &str = "2.0.2";
const PLUGIN_URL: &str = "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.2/bgutil-ytdlp-pot-provider.zip";
const PLUGIN_SHA256: &str = "a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef";
const PLUGIN_FILE: &str = "bgutil-ytdlp-pot-provider.zip";
/// Depois de um bloqueio do YouTube, os pedidos de token saem sem o guardado (um token novo) por um tempo.
const FRESH_FOR: Duration = Duration::from_secs(20);
/// Gerar um token (o BotGuard roda no nó) pode levar alguns segundos, mais na primeira vez.
const POT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct PotState {
    /// Pasta com o zip do plugin (`--plugin-dirs`).
    plugin_dir: Option<PathBuf>,
    /// Endereço do provedor no laço local deste processo.
    shim: Option<String>,
    /// Há de onde tirar o token agora (um nó de pé, ou `POT_PROVIDER_URL`).
    source: bool,
    /// No nó de mídia: o provedor dele mesmo, direto.
    direct: Option<String>,
}

static STATE: RwLock<PotState> = RwLock::new(PotState { plugin_dir: None, shim: None, source: false, direct: None });
static FRESH_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

/// Os argumentos do yt-dlp para pedir o token (vazio sem plugin ou sem de onde tirar o token).
pub fn ytdlp_args() -> Vec<String> {
    let s = STATE.read().unwrap();
    let Some(dir) = &s.plugin_dir else { return vec![] };
    let base = s.direct.clone().or_else(|| if s.source { s.shim.clone() } else { None });
    let Some(base) = base else { return vec![] };
    vec![
        "--plugin-dirs".into(),
        dir.display().to_string(),
        "--extractor-args".into(),
        format!("youtubepot-bgutilhttp:base_url={base}"),
    ]
}

/// O yt-dlp está pedindo token a cada música.
pub fn available() -> bool {
    !ytdlp_args().is_empty()
}

/// O YouTube bloqueou: os próximos pedidos de token vão sem o guardado.
pub fn mark_blocked() {
    *FRESH_UNTIL.lock().unwrap() = Some(Instant::now() + FRESH_FOR);
}

fn fresh() -> bool {
    FRESH_UNTIL.lock().unwrap().is_some_and(|t| Instant::now() < t)
}

/// No nó de mídia: o yt-dlp dele pede ao próprio provedor.
pub fn set_direct(url: Option<String>) {
    STATE.write().unwrap().direct = url;
}

fn env_provider() -> Option<String> {
    std::env::var("POT_PROVIDER_URL").ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty())
}

/// De tempos em tempos (`crate::media::start`): há um nó com token de pé agora?
pub fn refresh(media: &Registry) {
    let source = env_provider().is_some() || media.pot_node().is_some();
    STATE.write().unwrap().source = source;
}

/// O zip do plugin: `YTDLP_PLUGIN_DIRS` (a imagem Docker já traz), ou baixado (versão e SHA fixos) para
/// `<data>/yt-dlp-plugins`.
pub async fn ensure_plugin(http: &reqwest::Client, data_dir: &Path, logs: &Logs) -> Option<PathBuf> {
    if let Some(dir) = std::env::var("YTDLP_PLUGIN_DIRS").ok().filter(|v| !v.trim().is_empty()) {
        let dir = PathBuf::from(dir.trim());
        if dir.join(PLUGIN_FILE).is_file() {
            STATE.write().unwrap().plugin_dir = Some(dir.clone());
            return Some(dir);
        }
    }
    let dir = data_dir.join("yt-dlp-plugins");
    let zip = dir.join(PLUGIN_FILE);
    let marker = dir.join(format!("{PLUGIN_FILE}.{PLUGIN_VERSION}"));
    if !(zip.is_file() && marker.is_file()) {
        match super::tools::download_pinned(http, PLUGIN_URL, PLUGIN_SHA256).await {
            Ok(bytes) => {
                let saved = std::fs::create_dir_all(&dir)
                    .and_then(|_| std::fs::write(&zip, &bytes))
                    .and_then(|_| std::fs::write(&marker, PLUGIN_VERSION));
                if let Err(e) = saved {
                    logs.warn(format!("Token da música: não deu para salvar o plugin do yt-dlp ({e})"));
                    return None;
                }
            }
            Err(e) => {
                logs.warn(format!("Token da música: não deu para baixar o plugin do yt-dlp ({e})"));
                return None;
            }
        }
    }
    STATE.write().unwrap().plugin_dir = Some(dir.clone());
    Some(dir)
}

/// Sobe o provedor no laço local (só este computador alcança) e prepara o plugin.
pub async fn start_shim(app: Arc<App>) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    STATE.write().unwrap().shim = Some(format!("http://127.0.0.1:{port}"));
    refresh(&app.media);
    let router = Router::new().route("/get_pot", post(get_pot)).route("/ping", get(ping)).with_state(app.clone());
    let shutdown = app.hub.shutdown.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(shutdown.cancelled_owned()).await;
    });
    let app2 = app.clone();
    tokio::spawn(async move {
        if ensure_plugin(&app2.music.http, &app2.data_dir, &app2.logs).await.is_some() {
            app2.logs.info(format!("Token da música: plugin do yt-dlp pronto (bgutil {PLUGIN_VERSION})"));
        }
    });
    Ok(())
}

/// No nó de mídia: o provedor bgutil dele, para onde o intermediário local repassa (veja `use_local_provider`).
static LOCAL_TARGET: RwLock<Option<String>> = RwLock::new(None);
/// O endereço do intermediário local do nó (sobe uma vez só).
static LOCAL_SHIM: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);

/// No nó de mídia: o yt-dlp daqui pede o token ao provedor bgutil daqui (`target`) por um intermediário no laço
/// local, como o principal faz. É ele que pede um token novo (sem o guardado) depois de uma falha
/// (`mark_blocked`); falando direto com o bgutil, o yt-dlp reaproveitaria sempre o mesmo token.
pub async fn use_local_provider(target: String) {
    *LOCAL_TARGET.write().unwrap() = Some(target.clone());
    let mut shim = LOCAL_SHIM.lock().await;
    if shim.is_none() {
        let started = async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
            let port = listener.local_addr().ok()?.port();
            let router = Router::new().route("/get_pot", post(local_get_pot)).route("/ping", get(local_ping));
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            Some(format!("http://127.0.0.1:{port}"))
        }
        .await;
        *shim = started;
    }
    // Sem o intermediário (não deu para abrir a porta), fala direto com o provedor.
    set_direct(Some(shim.clone().unwrap_or(target)));
}

fn local_http() -> &'static reqwest::Client {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    HTTP.get_or_init(|| reqwest::Client::builder().timeout(POT_TIMEOUT).build().expect("cliente HTTP"))
}

async fn local_get_pot(Json(body): Json<Value>) -> Response {
    let Some(target) = LOCAL_TARGET.read().unwrap().clone() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "provedor de token parado" }));
    };
    match local_http().post(format!("{target}/get_pot")).json(&for_node(body)).send().await {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            reply(status, r.json().await.unwrap_or_else(|e| json!({ "error": e.to_string() })))
        }
        Err(e) => reply(StatusCode::BAD_GATEWAY, json!({ "error": e.to_string() })),
    }
}

async fn local_ping() -> Response {
    let Some(target) = LOCAL_TARGET.read().unwrap().clone() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "provedor de token parado" }));
    };
    match local_http().get(format!("{target}/ping")).timeout(Duration::from_secs(5)).send().await {
        Ok(r) => reply(StatusCode::OK, r.json().await.unwrap_or(Value::Null)),
        Err(e) => reply(StatusCode::BAD_GATEWAY, json!({ "error": e.to_string() })),
    }
}

/// O pedido do plugin, ajustado para o nó: o proxy e o endereço de saída daqui não valem na rede dele, e
/// depois de um bloqueio o token sai novo.
fn for_node(mut body: Value) -> Value {
    if let Some(o) = body.as_object_mut() {
        o.remove("proxy");
        o.remove("source_address");
        if fresh() {
            o.insert("bypass_cache".into(), json!(true));
        }
    }
    body
}

fn reply(status: StatusCode, v: Value) -> Response {
    (status, Json(v)).into_response()
}

async fn get_pot(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Response {
    let body = for_node(body);
    if let Some(url) = env_provider() {
        let res = app.music.http.post(format!("{url}/get_pot")).json(&body).timeout(POT_TIMEOUT).send().await;
        return match res {
            Ok(r) => {
                let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                reply(status, r.json().await.unwrap_or_else(|e| json!({ "error": e.to_string() })))
            }
            Err(e) => reply(StatusCode::BAD_GATEWAY, json!({ "error": e.to_string() })),
        };
    }
    let Some(node) = app.media.pot_node() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "Nenhum nó de mídia com token agora" }));
    };
    match app.media.request_for(&node, "pot", body, POT_TIMEOUT).await {
        Ok(v) if v.get("error").is_some() => reply(StatusCode::INTERNAL_SERVER_ERROR, v),
        Ok(v) => reply(StatusCode::OK, v),
        Err(e) => reply(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}

async fn ping(State(app): State<Arc<App>>) -> Response {
    if let Some(url) = env_provider() {
        return match app.music.http.get(format!("{url}/ping")).timeout(Duration::from_secs(5)).send().await {
            Ok(r) => reply(StatusCode::OK, r.json().await.unwrap_or(Value::Null)),
            Err(e) => reply(StatusCode::BAD_GATEWAY, json!({ "error": e.to_string() })),
        };
    }
    let Some(node) = app.media.pot_node() else {
        return reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "Nenhum nó de mídia com token agora" }));
    };
    match app.media.request_for(&node, "pot.ping", Value::Null, Duration::from_secs(5)).await {
        Ok(v) => reply(StatusCode::OK, v),
        Err(e) => reply(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depois_de_uma_falha_o_token_sai_novo() {
        *FRESH_UNTIL.lock().unwrap() = None;
        let pedido = json!({ "content_binding": "x", "proxy": "http://p", "source_address": "1.2.3.4" });
        let normal = for_node(pedido.clone());
        assert!(normal.get("bypass_cache").is_none() && normal.get("proxy").is_none() && normal.get("source_address").is_none());
        mark_blocked();
        assert_eq!(for_node(pedido)["bypass_cache"], json!(true));
        *FRESH_UNTIL.lock().unwrap() = None;
    }

    #[test]
    fn pedido_vai_ao_no_sem_proxy_e_novo_depois_de_bloqueio() {
        let body = json!({ "content_binding": "x", "proxy": "http://p", "source_address": "0.0.0.0", "bypass_cache": false });
        let v = for_node(body.clone());
        assert!(v.get("proxy").is_none() && v.get("source_address").is_none());
        assert_eq!(v["content_binding"], "x");
        assert_eq!(v["bypass_cache"], false);
        mark_blocked();
        assert_eq!(for_node(body)["bypass_cache"], true);
        *FRESH_UNTIL.lock().unwrap() = None;
    }

    #[test]
    fn sem_plugin_nem_fonte_o_yt_dlp_roda_como_antes() {
        let mut s = STATE.write().unwrap();
        let saved = std::mem::take(&mut *s);
        s.plugin_dir = Some(PathBuf::from("plugins"));
        s.shim = Some("http://127.0.0.1:9".into());
        drop(s);
        assert!(ytdlp_args().is_empty(), "sem nó com token");
        STATE.write().unwrap().source = true;
        let args = ytdlp_args();
        assert_eq!(args[0], "--plugin-dirs");
        assert_eq!(args[3], "youtubepot-bgutilhttp:base_url=http://127.0.0.1:9");
        *STATE.write().unwrap() = saved;
    }
}
