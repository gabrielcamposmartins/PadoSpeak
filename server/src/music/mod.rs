//! Fila de música por canal de voz.
//!
//! O servidor é o "DJ": guarda a fila, resolve links do YouTube/Spotify com o yt-dlp e serve o
//! áudio por proxy (`/api/music/stream/{id}`). Quem está no canal toca o mesmo stream em sincronia,
//! a partir do relógio da faixa (`startedAt`) definido aqui.
//!
//! Com um nó de mídia (`crate::media`), cada pedido ao YouTube leva um token novo do nó (`pot`), e, se o
//! YouTube bloquear este servidor mesmo assim (ou ele estiver sobrecarregado), o próprio nó busca o áudio
//! e o entrega por aqui (`crate::media::relay`).
pub mod library;
pub mod pot;
pub mod queue;
pub mod resolve;
pub mod stream;
pub mod tools;

pub use queue::MusicManager;

use crate::models::User;
use serde::{Deserialize, Serialize};

/// De onde vem o áudio de uma faixa.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// URL de vídeo do YouTube.
    Youtube(String),
    /// Busca no YouTube ("artista - título"), resolvida só quando a faixa for tocar (links do Spotify).
    Search(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Id da entrada na fila (único mesmo que a mesma música seja adicionada duas vezes).
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: Option<u64>,
    pub thumbnail: Option<String>,
    /// Link original (YouTube ou Spotify), para abrir no navegador.
    pub page_url: String,
    pub added_by: Option<User>,
    #[serde(skip)]
    pub source: Source,
}

/// Executa um programa sem abrir janela de console no Windows (o app desktop não tem console).
pub(crate) fn command(program: &std::ffi::OsStr) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.kill_on_drop(true).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}
