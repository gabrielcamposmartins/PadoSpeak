//! PadoSpeak — servidor de chat estilo Discord (biblioteca).
//!
//! Usado pelo binário `padospeak-server` (VM/headless/Docker) e embutido no app desktop
//! (Tauri), onde o botão "Hostear" chama [`HostManager::start`].
pub mod api;
pub mod assets;
pub mod auth;
pub mod config;
pub mod db;
pub mod host;
pub mod hub;
pub mod lan;
pub mod logs;
pub mod models;
pub mod social;
pub mod stickers;
pub mod music;
pub mod panel;
pub mod tls;

pub use config::HostConfig;
pub use host::{HostManager, HostStatus};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
