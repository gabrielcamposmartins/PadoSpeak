//! Configuração do host. Ordem de precedência: padrão < salvo no banco < variáveis de ambiente.
use crate::db::Db;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum HttpsMode {
    Off,
    SelfSigned,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostConfig {
    pub server_name: String,
    pub port: u16,
    pub host: String,
    pub https: HttpsMode,
    pub tls_cert: String,
    pub tls_key: String,
    pub allow_registration: bool,
    /// Lista de RTCIceServer repassada sem alteração aos clientes (STUN/TURN).
    pub ice_servers: Vec<Value>,
    /// Música: arquivo cookies.txt (formato Netscape) para o YouTube, se ele exigir login/anti-robô.
    pub music_cookies_file: String,
    /// Música: navegador de onde o yt-dlp lê os cookies (firefox, edge, chrome…). Ignorado se houver arquivo.
    pub music_cookies_browser: String,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            server_name: "PadoSpeak".into(),
            port: 3000,
            host: "0.0.0.0".into(),
            https: HttpsMode::Off,
            tls_cert: String::new(),
            tls_key: String::new(),
            allow_registration: true,
            ice_servers: vec![json!({ "urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] })],
            music_cookies_file: String::new(),
            music_cookies_browser: String::new(),
        }
    }
}

const SETTINGS_KEY: &str = "host_config";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Campos definidos por variável de ambiente (ficam travados no painel).
fn apply_env(cfg: &mut HostConfig) -> Vec<&'static str> {
    let mut locked = Vec::new();
    if let Some(v) = env("SERVER_NAME") {
        cfg.server_name = v;
        locked.push("serverName");
    }
    if let Some(v) = env("PORT").and_then(|v| v.parse().ok()) {
        cfg.port = v;
        locked.push("port");
    }
    if let Some(v) = env("HOST") {
        cfg.host = v;
        locked.push("host");
    }
    if let Some(v) = env("HTTPS").and_then(|v| serde_json::from_value(Value::String(v)).ok()) {
        cfg.https = v;
        locked.push("https");
    }
    if let Some(v) = env("TLS_CERT") {
        cfg.tls_cert = v;
        locked.push("tlsCert");
    }
    if let Some(v) = env("TLS_KEY") {
        cfg.tls_key = v;
        locked.push("tlsKey");
    }
    if let Some(v) = env("ALLOW_REGISTRATION") {
        cfg.allow_registration = matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on");
        locked.push("allowRegistration");
    }
    if let Some(v) = env("YTDLP_COOKIES") {
        cfg.music_cookies_file = v;
        locked.push("musicCookiesFile");
    }
    if let Some(v) = env("YTDLP_COOKIES_FROM_BROWSER") {
        cfg.music_cookies_browser = v;
        locked.push("musicCookiesBrowser");
    }
    if let Some(v) = env("ICE_SERVERS") {
        match serde_json::from_str(&v) {
            Ok(list) => {
                cfg.ice_servers = list;
                locked.push("iceServers");
            }
            Err(e) => eprintln!("ICE_SERVERS inválido ({e}); ignorando"),
        }
    }
    locked
}

pub fn locked_keys() -> Vec<&'static str> {
    apply_env(&mut HostConfig::default())
}

pub async fn load(db: &Db) -> HostConfig {
    let mut cfg = match db.get_setting(SETTINGS_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => HostConfig::default(),
    };
    apply_env(&mut cfg);
    cfg
}

pub fn validate(cfg: &mut HostConfig) -> Result<(), String> {
    cfg.server_name = cfg.server_name.trim().chars().take(64).collect();
    if cfg.server_name.is_empty() {
        return Err("Nome do servidor obrigatório".into());
    }
    if cfg.port == 0 {
        return Err("Porta inválida".into());
    }
    if cfg.https == HttpsMode::Custom && (cfg.tls_cert.is_empty() || cfg.tls_key.is_empty()) {
        return Err("Informe os caminhos do certificado e da chave TLS".into());
    }
    let file = cfg.music_cookies_file.trim();
    if !file.is_empty() && !std::path::Path::new(file).is_file() {
        return Err(format!("Arquivo de cookies não encontrado: {file}"));
    }
    if cfg.host.parse::<std::net::IpAddr>().is_err() {
        return Err("Endereço de bind inválido (use 0.0.0.0, 127.0.0.1 ou um IP)".into());
    }
    Ok(())
}

/// Valida, salva no banco e devolve a configuração efetiva (com as variáveis de ambiente aplicadas).
pub async fn save(db: &Db, mut cfg: HostConfig) -> Result<HostConfig, String> {
    validate(&mut cfg)?;
    let raw = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    db.set_setting(SETTINGS_KEY, &raw).await.map_err(|e| e.to_string())?;
    apply_env(&mut cfg);
    Ok(cfg)
}
