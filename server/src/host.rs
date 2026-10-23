//! `HostManager`: liga e desliga o servidor de chat sob demanda.
//! É o que o botão "Hostear" aciona — no painel web do binário e no app desktop (Tauri).
use crate::config::{self, HostConfig, HttpsMode};
use crate::db::{Db, DbInfo};
use crate::hub::{Hub, HubStats};
use crate::logs::{LogLine, Logs};
use axum::routing::get;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower_http::cors::CorsLayer;

/// Estado compartilhado pelas rotas enquanto o servidor está no ar.
pub struct App {
    pub db: Db,
    pub hub: Arc<Hub>,
    pub config: HostConfig,
    pub logs: Logs,
    /// Endereços pelos quais o servidor é alcançável (localhost primeiro, depois a rede).
    pub urls: Vec<String>,
    pub music: Arc<crate::music::MusicManager>,
    /// Presente só no nó local do app desktop (perfil local + rede local).
    pub lan: Option<Arc<crate::lan::Lan>>,
    /// Notificações push (só no servidor de comunidade; o nó local usa as do Windows).
    pub push: Option<Arc<crate::push::Push>>,
    /// Pasta de dados (arquivos enviados nas conversas ficam em `arquivos/`).
    pub data_dir: PathBuf,
    /// Registro de cada servidor (veja `crate::audit`).
    pub audit: crate::audit::Sender,
    /// Relay das chamadas (TURN), com senha temporária por usuário (veja `crate::turn`).
    pub turn: Option<crate::turn::Turn>,
    /// E-mail (SMTP) e login com o Google (veja `crate::account`); só no servidor de comunidade.
    pub mail: Option<crate::account::Mailer>,
    pub google: Option<crate::account::Google>,
    /// "Esconder meu perfil de" (veja `crate::privacy`).
    pub privacy: Arc<crate::privacy::Privacy>,
}

struct Running {
    app: Arc<App>,
    handle: Handle<SocketAddr>,
    task: JoinHandle<()>,
    started_at: i64,
    urls: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub running: bool,
    pub started_at: Option<i64>,
    pub config: HostConfig,
    pub locked_keys: Vec<&'static str>,
    pub urls: Vec<String>,
    pub stats: HubStats,
    pub totals: Totals,
    pub db: DbInfo,
    pub data_dir: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub users: i64,
    pub guilds: i64,
    pub messages: i64,
}

pub struct HostManager {
    db: Db,
    logs: Logs,
    data_dir: PathBuf,
    running: Mutex<Option<Running>>,
    /// Nó local: guarda o perfil deste PC e conversa com a rede local (não é um servidor de comunidade).
    local_node: bool,
    /// Servidor que este PC está hospedando (anunciado na rede local).
    hosting: std::sync::Mutex<Option<crate::lan::Hosting>>,
}

impl HostManager {
    pub async fn new(data_dir: PathBuf) -> Result<Arc<Self>, crate::BoxError> {
        // rustls precisa de um provedor de criptografia; usamos o `ring` (sem dependências nativas extras).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let logs = Logs::default();
        let db = Db::open(&data_dir).await?;
        logs.info(format!("Banco Turso/libSQL pronto ({}: {})", db.info.mode, db.info.location));
        logs.info(format!("Mensagens guardadas com criptografia AES-256-GCM (chave {})", db.cipher.fingerprint));
        if let Some(w) = &db.info.key_warning {
            logs.error(w.clone());
        }
        Ok(Arc::new(Self {
            db,
            logs,
            data_dir,
            running: Mutex::new(None),
            local_node: false,
            hosting: std::sync::Mutex::new(None),
        }))
    }

    /// Nó local do app desktop: perfil local e conversas com a rede local.
    pub async fn new_local(data_dir: PathBuf) -> Result<Arc<Self>, crate::BoxError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let logs = Logs::default();
        let db = Db::open(&data_dir).await?;
        Ok(Arc::new(Self {
            db,
            logs,
            data_dir,
            running: Mutex::new(None),
            local_node: true,
            hosting: std::sync::Mutex::new(None),
        }))
    }

    pub fn is_local_node(&self) -> bool {
        self.local_node
    }

    /// Avisa a rede local qual servidor este PC está hospedando (ou `None`).
    pub async fn set_lan_hosting(&self, hosting: Option<crate::lan::Hosting>) {
        *self.hosting.lock().unwrap() = hosting.clone();
        if let Some(lan) = self.running.lock().await.as_ref().and_then(|r| r.app.lan.clone()) {
            lan.set_hosting(hosting);
        }
    }

    /// Identificador deste PC na rede local (criado na primeira vez).
    async fn node_id(&self) -> String {
        if let Ok(Some(id)) = self.db.get_setting("lan_node_id").await {
            return id;
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let _ = self.db.set_setting("lan_node_id", &id).await;
        id
    }

    pub fn logs(&self) -> &Logs {
        &self.logs
    }

    pub async fn saved_config(&self) -> HostConfig {
        config::load(&self.db).await
    }

    /// Salva a configuração e coloca o servidor no ar.
    pub async fn start(&self, cfg: Option<HostConfig>) -> Result<HostStatus, String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Err("O servidor já está no ar".into());
        }
        let cfg = match cfg {
            // O nó local não grava a configuração (ela vem sempre do app).
            Some(mut c) if self.local_node => {
                config::validate(&mut c)?;
                c
            }
            Some(c) => config::save(&self.db, c).await?,
            None => {
                let mut c = config::load(&self.db).await;
                config::validate(&mut c)?;
                c
            }
        };

        let ip: IpAddr = cfg.host.parse().map_err(|_| "Endereço de bind inválido".to_string())?;
        let addr = SocketAddr::new(ip, cfg.port);
        let listener = std::net::TcpListener::bind(addr).map_err(|e| format!("Não foi possível abrir {addr}: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;

        let tls = crate::tls::resolve(&cfg, &self.data_dir)?;
        let scheme = if tls.is_some() { "https" } else { "http" };
        let urls = public_urls(scheme, ip, cfg.port);
        let (hub, voice_empty) = Hub::new();
        let music = crate::music::MusicManager::new(
            hub.clone(),
            self.db.clone(),
            self.logs.clone(),
            self.data_dir.clone(),
            (cfg.music_cookies_file.clone(), cfg.music_cookies_browser.clone()),
            voice_empty,
        );
        music.warm_up();
        music.restore_after_restart();
        let lan = if self.local_node {
            Some(crate::lan::Lan::new(self.node_id().await, cfg.port, self.hosting.lock().unwrap().clone()))
        } else {
            None
        };
        let push = if self.local_node {
            None
        } else {
            match crate::push::Push::load(&self.db).await {
                Ok(p) => Some(p),
                Err(e) => {
                    self.logs.warn(format!("Notificações push indisponíveis: {e}"));
                    None
                }
            }
        };
        let (audit_tx, audit_rx) = tokio::sync::mpsc::unbounded_channel();
        hub.set_audit(audit_tx.clone());
        let turn = if self.local_node { None } else { crate::turn::Turn::from_env() };
        if let Some(t) = &turn {
            self.logs.info(format!("Relay das chamadas (TURN): {}", t.urls().join(", ")));
        }
        let mail = if self.local_node { None } else { crate::account::Mailer::from_env() };
        let google = if self.local_node { None } else { crate::account::Google::from_env() };
        if mail.is_some() {
            self.logs.info("E-mail ligado (confirmação de e-mail e recuperação de senha)");
        }
        if google.is_some() {
            self.logs.info("Login com o Google ligado");
        }
        let privacy = Arc::new(crate::privacy::Privacy::load(&self.db).await);
        let app = Arc::new(App {
            privacy,
            mail,
            google,
            audit: audit_tx,
            db: self.db.clone(),
            hub,
            music,
            config: cfg.clone(),
            logs: self.logs.clone(),
            urls: urls.clone(),
            lan: lan.clone(),
            push,
            data_dir: self.data_dir.clone(),
            turn,
        });
        if let Some(lan) = &lan {
            app.hub.set_lan_mode();
            lan.spawn(app.clone());
        }
        // Arquivos e áudios vencidos somem (com a mensagem que os mostrava).
        crate::files::spawn_sweeper(app.clone());
        crate::audit::spawn_writer(app.clone(), audit_rx);
        // Canais privados: o hub precisa saber quem vê cada um antes da primeira conexão.
        if crate::api::refresh_audiences(&app, None).await.is_err() {
            self.logs.warn("Não foi possível carregar os canais privados");
        }
        let router = Router::new()
            .merge(crate::api::router())
            .merge(crate::social::router())
            .merge(crate::lan::router())
            .merge(crate::stickers::router())
            .merge(crate::sounds::router())
            .merge(crate::account::router())
            .merge(crate::push::router())
            .merge(crate::files::router())
            .merge(crate::audit::router())
            .merge(crate::admin::router())
            .merge(crate::pins::router())
            .merge(crate::search::router())
            .merge(crate::backgrounds::router())
            .route("/ws", get(crate::hub::ws_handler))
            .route("/api/music/stream/{id}", get(crate::music::stream::handler))
            .fallback(crate::assets::static_handler)
            .layer(axum::middleware::from_fn_with_state(app.clone(), crate::privacy::layer))
            .layer(CorsLayer::permissive())
            .with_state(app.clone());

        let handle = Handle::new();
        let logs = self.logs.clone();
        let task = match tls {
            Some((cert, key)) => {
                let tls_cfg = RustlsConfig::from_pem(cert, key).await.map_err(|e| format!("TLS: {e}"))?;
                let server = axum_server::from_tcp_rustls(listener, tls_cfg).map_err(|e| e.to_string())?.handle(handle.clone());
                tokio::spawn(async move {
                    if let Err(e) = server.serve(router.into_make_service_with_connect_info::<SocketAddr>()).await {
                        logs.error(format!("Servidor parou com erro: {e}"));
                    }
                })
            }
            None => {
                let server = axum_server::from_tcp(listener).map_err(|e| e.to_string())?.handle(handle.clone());
                tokio::spawn(async move {
                    if let Err(e) = server.serve(router.into_make_service_with_connect_info::<SocketAddr>()).await {
                        logs.error(format!("Servidor parou com erro: {e}"));
                    }
                })
            }
        };

        self.logs.info(format!("Servidor \"{}\" no ar em {}", cfg.server_name, urls.join(" | ")));
        if cfg.https == HttpsMode::Off && !ip.is_loopback() && !self.local_node {
            self.logs.warn(
                "HTTPS desligado: no navegador, voz/vídeo/tela só funcionam via localhost. \
                 Use HTTPS (autoassinado ou próprio) para acessos pela rede — o app desktop funciona sem HTTPS.",
            );
        }
        *running = Some(Running { app, handle, task, started_at: crate::now_ms(), urls });
        drop(running);
        Ok(self.status().await)
    }

    /// Desliga para reiniciar (atualização, SIGTERM do Docker): avisa os apps para voltarem logo, sem
    /// encerrar as chamadas, e guarda a música para o servidor novo continuar.
    pub async fn stop_for_restart(&self) -> HostStatus {
        if !self.local_node {
            if let Some(r) = self.running.lock().await.as_ref() {
                r.app.hub.announce_restart();
                r.app.music.save_for_restart();
            }
            // Tempo para o aviso sair antes de as conexões fecharem.
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        self.stop().await
    }

    pub async fn stop(&self) -> HostStatus {
        if let Some(r) = self.running.lock().await.take() {
            r.app.hub.shutdown.cancel();
            r.handle.graceful_shutdown(Some(Duration::from_secs(3)));
            let _ = tokio::time::timeout(Duration::from_secs(5), r.task).await;
            self.logs.info("Servidor desligado");
        }
        self.status().await
    }

    pub async fn status(&self) -> HostStatus {
        let running = self.running.lock().await;
        let config = match running.as_ref() {
            Some(r) => r.app.config.clone(),
            None => config::load(&self.db).await,
        };
        HostStatus {
            running: running.is_some(),
            started_at: running.as_ref().map(|r| r.started_at),
            config,
            locked_keys: config::locked_keys(),
            urls: running.as_ref().map(|r| r.urls.clone()).unwrap_or_default(),
            stats: running.as_ref().map(|r| r.app.hub.stats()).unwrap_or_default(),
            totals: self.totals().await,
            db: self.db.info.clone(),
            data_dir: self.data_dir.to_string_lossy().into_owned(),
        }
    }

    async fn totals(&self) -> Totals {
        let count = |table: &'static str| async move {
            self.db
                .query_one(&format!("SELECT COUNT(*) FROM {table}"), (), |r| r.get::<i64>(0))
                .await
                .ok()
                .flatten()
                .unwrap_or(0)
        };
        Totals { users: count("users").await, guilds: count("guilds").await, messages: count("messages").await }
    }

    pub fn logs_since(&self, after: u64) -> Vec<LogLine> {
        self.logs.since(after)
    }
}

fn public_urls(scheme: &str, ip: IpAddr, port: u16) -> Vec<String> {
    let mut hosts = vec!["localhost".to_string()];
    if ip.is_unspecified() {
        hosts.extend(crate::tls::lan_addresses().iter().map(IpAddr::to_string));
    } else if !ip.is_loopback() {
        hosts.push(ip.to_string());
    }
    hosts.into_iter().map(|h| format!("{scheme}://{h}:{port}")).collect()
}
