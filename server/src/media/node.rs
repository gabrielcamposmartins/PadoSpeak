//! O processo do nó de mídia: liga para o servidor principal (`super::control`), roda o SFU e atende os
//! pedidos de token do YouTube e de música. Roda pela linha de comando (`padospeak-server media`, também
//! na imagem Docker) ou dentro do app do Windows (Hostear → Nó de mídia).
//!
//! Se a ligação com o principal cair, as chamadas continuam pelo SFU (a mídia não passa pelo principal) e o
//! nó religa sozinho. Se o principal reiniciou (`bootId` novo), quem não voltar em `PRUNE_AFTER` sai.
use super::control::{self, Hello, Pairing};
use super::pot::Provider;
use super::sfu::{Sfu, SfuConfig, DEFAULT_UDP_PORT};
use crate::logs::Logs;
use crate::music::stream::{Audio, Clients, AUDIO_TTL};
use crate::music::tools::Tools;
use crate::music::Source;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message as TMsg;
use tokio_util::sync::CancellationToken;

/// Depois de o principal reiniciar, as sessões do SFU de quem não voltou saem depois disto.
const PRUNE_AFTER: Duration = Duration::from_secs(60);
/// O principal calado por este tempo: a ligação morreu (religa).
const SERVER_SILENT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct NodeConfig {
    pub pairing: Pairing,
    pub udp_port: u16,
    /// IPs públicos anunciados pelo SFU (além do que o principal vê e dos da rede local).
    pub public_ips: Vec<IpAddr>,
    pub data_dir: PathBuf,
    /// Dar token do YouTube (`POT=off` desliga).
    pub pot: bool,
    /// Buscar a música pelo nó (`MEDIA_MUSIC=off` desliga).
    pub music: bool,
}

impl NodeConfig {
    /// `MEDIA_JOIN` (código de pareamento, do Painel → Mídia), `SFU_UDP_PORT` (padrão 3479),
    /// `SFU_PUBLIC_IP`, `POT=off`, `MEDIA_MUSIC=off`.
    pub fn from_env(data_dir: PathBuf) -> Result<Self, String> {
        let env = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let off = |k: &str| env(k).is_some_and(|v| matches!(v.to_lowercase().as_str(), "0" | "off" | "false" | "no"));
        let code = env("MEDIA_JOIN").ok_or("Defina MEDIA_JOIN com o código do nó (Painel → Mídia → Adicionar nó)")?;
        let sfu = SfuConfig::from_env();
        let public_ips = env("SFU_PUBLIC_IP").map(|v| v.split(',').filter_map(|ip| ip.trim().parse().ok()).collect()).unwrap_or_default();
        Ok(Self { pairing: Pairing::decode(&code)?, udp_port: sfu.port, public_ips, data_dir, pot: !off("POT"), music: !off("MEDIA_MUSIC") })
    }

    pub fn new(code: &str, udp_port: Option<u16>, data_dir: PathBuf) -> Result<Self, String> {
        Ok(Self {
            pairing: Pairing::decode(code)?,
            udp_port: udp_port.unwrap_or(DEFAULT_UDP_PORT),
            public_ips: Vec::new(),
            data_dir,
            pot: true,
            music: true,
        })
    }
}

/// O que o nó está fazendo (o app do Windows mostra no Hostear).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    pub running: bool,
    pub connected: bool,
    pub server: String,
    /// Nome do nó no painel do servidor.
    pub name: String,
    /// IP pelo qual o servidor viu o nó.
    pub public_ip: String,
    pub udp_port: u16,
    pub peers: usize,
    pub rooms: usize,
    /// `desligado`, `preparando`, `pronto` ou o erro.
    pub pot: String,
    pub error: Option<String>,
    pub since: Option<i64>,
}

pub struct MediaNode {
    shared: Arc<Shared>,
}

struct Shared {
    cfg: NodeConfig,
    logs: Logs,
    sfu: Arc<Sfu>,
    status: Mutex<NodeStatus>,
    stop: CancellationToken,
    /// A ligação atual com o principal (as respostas e os eventos do SFU saem por ela).
    out: Mutex<Option<UnboundedSender<String>>>,
    /// conexão do principal → último comando para ela (para tirar quem não voltou depois de reiniciar).
    conns: Mutex<HashMap<String, Instant>>,
    http: reqwest::Client,
    pot: tokio::sync::Mutex<Option<Provider>>,
    music: NodeMusic,
    /// Tokens e músicas que este nó já serviu (vão no batimento; o painel mostra).
    pot_served: std::sync::atomic::AtomicU64,
    music_served: std::sync::atomic::AtomicU64,
}

impl MediaNode {
    /// Abre a porta UDP do SFU e começa a ligar para o principal.
    pub fn start(cfg: NodeConfig, logs: Logs) -> Result<Arc<Self>, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let stop = CancellationToken::new();
        let (tx, rx) = unbounded_channel();
        let sfu = Sfu::start(SfuConfig::new(cfg.udp_port, cfg.public_ips.clone()), tx, &stop)?;
        let status = NodeStatus {
            running: true,
            server: cfg.pairing.url.clone(),
            udp_port: sfu.port,
            pot: if cfg.pot { "preparando".into() } else { "desligado".into() },
            ..Default::default()
        };
        logs.info(format!("Nó de mídia: SFU na porta UDP {}, ligando para {}", sfu.port, cfg.pairing.url));
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
        let shared = Arc::new(Shared {
            music: NodeMusic::new(cfg.data_dir.clone(), logs.clone(), http.clone()),
            cfg,
            logs,
            sfu,
            status: Mutex::new(status),
            stop,
            out: Mutex::new(None),
            conns: Mutex::new(HashMap::new()),
            http,
            pot: tokio::sync::Mutex::new(None),
            pot_served: Default::default(),
            music_served: Default::default(),
        });
        tokio::spawn(shared.clone().forward_events(rx));
        tokio::spawn(shared.clone().run());
        if shared.cfg.pot {
            tokio::spawn(shared.clone().prepare_pot());
        }
        Ok(Arc::new(Self { shared }))
    }

    pub fn status(&self) -> NodeStatus {
        let mut s = self.shared.status.lock().unwrap().clone();
        s.peers = self.shared.sfu.stats.peers.load(Ordering::Relaxed);
        s.rooms = self.shared.sfu.stats.rooms.load(Ordering::Relaxed);
        s.running = !self.shared.stop.is_cancelled();
        s
    }

    pub fn stop(&self) {
        self.shared.stop.cancel();
    }

    pub async fn stopped(&self) {
        self.shared.stop.cancelled().await;
    }
}

impl Shared {
    fn send(&self, msg: String) {
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            let _ = tx.send(msg);
        }
    }

    fn set_status(&self, f: impl FnOnce(&mut NodeStatus)) {
        f(&mut self.status.lock().unwrap());
    }

    /// Eventos do SFU para as conexões do principal.
    async fn forward_events(self: Arc<Self>, mut rx: UnboundedReceiver<(String, String)>) {
        while let Some((conn, msg)) = rx.recv().await {
            self.send(json!({ "t": "ev", "conn": conn, "msg": msg }).to_string());
        }
    }

    /// Liga, e religa quando cair, até o nó parar.
    async fn run(self: Arc<Self>) {
        let mut backoff = Duration::from_secs(1);
        let mut boot_id: Option<String> = None;
        loop {
            let started = Instant::now();
            let result = self.clone().session(&mut boot_id).await;
            *self.out.lock().unwrap() = None;
            self.set_status(|s| {
                s.connected = false;
                s.error = result.as_ref().err().cloned();
            });
            if self.stop.is_cancelled() {
                break;
            }
            let refused = matches!(&result, Err(e) if e.starts_with("recusado"));
            if let Err(e) = &result {
                self.logs.warn(format!("Nó de mídia: {e}"));
            }
            // Ficou de pé um bom tempo: religa logo. Recusado (código errado, nó removido): espera mais.
            backoff = if started.elapsed() > Duration::from_secs(30) { Duration::from_secs(1) } else { (backoff * 2).min(Duration::from_secs(20)) };
            let wait = if refused { Duration::from_secs(30) } else { backoff };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.stop.cancelled() => break,
            }
        }
        self.sfu.shutdown();
        *self.pot.lock().await = None;
        self.logs.info("Nó de mídia: desligado");
    }

    async fn session(self: Arc<Self>, boot_id: &mut Option<String>) -> Result<(), String> {
        let url = self.cfg.pairing.control_url();
        let (ws, _) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url.as_str()))
            .await
            .map_err(|_| format!("o servidor {} não respondeu", self.cfg.pairing.url))?
            .map_err(|e| format!("não deu para ligar para {}: {e}", self.cfg.pairing.url))?;
        let (mut sink, mut stream) = ws.split();
        let mut caps = vec!["sfu".to_string()];
        if self.cfg.pot {
            caps.push("pot".into());
        }
        if self.cfg.music {
            caps.push("music".into());
        }
        let lan: Vec<String> = crate::tls::lan_addresses().iter().filter(|ip| ip.is_ipv4()).map(|ip| ip.to_string()).collect();
        let hello = Hello::new(&self.cfg.pairing, caps, self.sfu.port, lan.clone(), crate::now_ms());
        let mut msg = serde_json::to_value(&hello).map_err(|e| e.to_string())?;
        msg["t"] = json!("hello");
        sink.send(TMsg::Text(msg.to_string().into())).await.map_err(|e| e.to_string())?;
        let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.map_err(|_| "o servidor não respondeu ao pareamento".to_string())?;
        let Some(Ok(TMsg::Text(text))) = first else { return Err("o servidor fechou a ligação".into()) };
        let welcome: Value = serde_json::from_str(text.as_str()).unwrap_or(Value::Null);
        if welcome["t"] == "refused" {
            return Err(format!("recusado pelo servidor: {}", welcome["error"].as_str().unwrap_or("?")));
        }
        if welcome["t"] != "welcome" {
            return Err("resposta inesperada do servidor".into());
        }
        let public_ip = welcome["publicIp"].as_str().unwrap_or_default().to_string();
        // Anuncia o IP pelo qual o principal viu o nó (o público, atrás de NAT), além dos configurados.
        if let Ok(ip) = public_ip.parse::<IpAddr>() {
            let mut ips = self.cfg.public_ips.clone();
            if ip.is_ipv4() && !ip.is_loopback() && !ips.contains(&ip) {
                ips.push(ip);
            }
            self.sfu.set_addrs(SfuConfig::new(self.sfu.port, ips).ips);
        }
        let new_boot = welcome["bootId"].as_str().map(str::to_string);
        if boot_id.is_some() && *boot_id != new_boot {
            // O principal reiniciou: quem voltar retoma a sessão (`rekey`); quem não voltar sai.
            self.clone().prune_later(Instant::now());
        }
        *boot_id = new_boot;
        self.set_status(|s| {
            s.connected = true;
            s.error = None;
            s.public_ip = public_ip.clone();
            s.name = welcome["name"].as_str().unwrap_or_default().to_string();
            s.since = Some(crate::now_ms());
        });
        self.logs.info(format!("Nó de mídia: ligado a {} como \"{}\" (visto de {public_ip})", self.cfg.pairing.url, welcome["name"].as_str().unwrap_or("?")));

        let (tx, mut rx) = unbounded_channel::<String>();
        *self.out.lock().unwrap() = Some(tx);
        let mut beat = tokio::time::interval(control::BEAT_EVERY);
        let mut last_heard = Instant::now();
        let mut prev_bytes = (self.sfu.stats.bytes_out.load(Ordering::Relaxed), Instant::now());
        loop {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(TMsg::Text(text))) => {
                        last_heard = Instant::now();
                        self.clone().on_message(text.as_str());
                    }
                    Some(Ok(TMsg::Close(_))) | None => return Err("o servidor fechou a ligação".into()),
                    Some(Err(e)) => return Err(format!("ligação caiu: {e}")),
                    Some(Ok(_)) => last_heard = Instant::now(),
                },
                out = rx.recv() => match out {
                    Some(text) => sink.send(TMsg::Text(text.into())).await.map_err(|e| format!("ligação caiu: {e}"))?,
                    None => return Err("ligação encerrada".into()),
                },
                _ = beat.tick() => {
                    if last_heard.elapsed() > SERVER_SILENT {
                        return Err("o servidor parou de responder".into());
                    }
                    let bytes = self.sfu.stats.bytes_out.load(Ordering::Relaxed);
                    let secs = prev_bytes.1.elapsed().as_secs_f64().max(0.001);
                    let kbps = ((bytes.saturating_sub(prev_bytes.0)) as f64 * 8.0 / 1000.0 / secs) as u64;
                    prev_bytes = (bytes, Instant::now());
                    let pot = self.status.lock().unwrap().pot.clone();
                    let load = json!({
                        "peers": self.sfu.stats.peers.load(Ordering::Relaxed),
                        "rooms": self.sfu.stats.rooms.load(Ordering::Relaxed),
                        "kbps": kbps,
                        "pot": pot,
                        "potServed": self.pot_served.load(Ordering::Relaxed),
                        "musicServed": self.music_served.load(Ordering::Relaxed),
                    });
                    sink.send(TMsg::Text(json!({ "t": "beat", "load": load }).to_string().into())).await.map_err(|e| format!("ligação caiu: {e}"))?;
                }
                _ = self.stop.cancelled() => {
                    let _ = sink.send(TMsg::Close(None)).await;
                    return Ok(());
                }
            }
        }
    }

    /// Depois de o principal reiniciar: as sessões que ninguém retomou saem.
    fn prune_later(self: Arc<Self>, since: Instant) {
        tokio::spawn(async move {
            tokio::time::sleep(PRUNE_AFTER).await;
            let stale: Vec<String> = self.conns.lock().unwrap().iter().filter(|(_, t)| **t < since).map(|(c, _)| c.clone()).collect();
            for conn in stale {
                self.sfu.leave(&conn);
                self.conns.lock().unwrap().remove(&conn);
            }
        });
    }

    fn touch(&self, conn: &str) {
        if !conn.is_empty() {
            self.conns.lock().unwrap().insert(conn.to_string(), Instant::now());
        }
    }

    fn on_message(self: Arc<Self>, text: &str) {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return };
        let op = v.get("op").and_then(Value::as_str).unwrap_or_default().to_string();
        let d = v.get("d").cloned().unwrap_or(Value::Null);
        match v.get("t").and_then(Value::as_str) {
            Some("cmd") => self.on_cmd(&op, d),
            Some("req") => {
                let Some(id) = v.get("id").and_then(Value::as_u64) else { return };
                tokio::spawn(async move {
                    let res = self.on_req(&op, d).await;
                    self.send(json!({ "t": "res", "id": id, "d": res }).to_string());
                });
            }
            _ => {}
        }
    }

    fn on_cmd(self: Arc<Self>, op: &str, d: Value) {
        let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        match op {
            "music.fetch" => {
                let base = control::ws_base(&self.cfg.pairing.url);
                self.music_served.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(async move { self.music.fetch(&base, &d).await });
            }
            "leave" => {
                self.conns.lock().unwrap().remove(&s("conn"));
                super::apply_cmd(&self.sfu, op, &d);
            }
            "rekey" => {
                let mut conns = self.conns.lock().unwrap();
                conns.remove(&s("old"));
                conns.insert(s("new"), Instant::now());
                drop(conns);
                super::apply_cmd(&self.sfu, op, &d);
            }
            _ => {
                self.touch(&s("conn"));
                super::apply_cmd(&self.sfu, op, &d);
            }
        }
    }

    async fn on_req(&self, op: &str, d: Value) -> Value {
        match op {
            "publish" => {
                self.touch(d.get("conn").and_then(Value::as_str).unwrap_or_default());
                super::publish(&self.sfu, &d).await
            }
            "pot" | "pot.ping" if self.cfg.pot => {
                let mut slot = self.pot.lock().await;
                if slot.as_mut().is_none_or(|p| !p.alive()) {
                    *slot = None;
                    match super::pot::launch(&self.http, &self.cfg.data_dir, &self.logs).await {
                        Ok(p) => {
                            crate::music::pot::set_direct(Some(p.base.clone()));
                            self.set_status(|s| s.pot = "pronto".into());
                            *slot = Some(p);
                        }
                        Err(e) => {
                            self.set_status(|s| s.pot = format!("erro: {e}"));
                            return json!({ "error": e });
                        }
                    }
                }
                let p = slot.as_ref().expect("provedor de pé");
                if op == "pot" {
                    self.pot_served.fetch_add(1, Ordering::Relaxed);
                    p.get_pot(&self.http, &d).await
                } else {
                    p.ping(&self.http).await
                }
            }
            "music.resolve" if self.cfg.music => self.music.resolve(&d).await,
            _ => json!({ "error": "Este nó não faz isso" }),
        }
    }

    /// Prepara o provedor de token logo ao ligar (a primeira vez baixa e instala; leva minutos).
    async fn prepare_pot(self: Arc<Self>) {
        let _ = crate::music::pot::ensure_plugin(&self.http, &self.cfg.data_dir, &self.logs).await;
        let mut slot = self.pot.lock().await;
        if slot.is_some() {
            return;
        }
        match super::pot::launch(&self.http, &self.cfg.data_dir, &self.logs).await {
            Ok(p) => {
                crate::music::pot::set_direct(Some(p.base.clone()));
                self.set_status(|s| s.pot = "pronto".into());
                *slot = Some(p);
            }
            Err(e) => {
                self.logs.warn(format!("Token: o provedor não subiu ({e}); tenta de novo no próximo pedido"));
                self.set_status(|s| s.pot = format!("erro: {e}"));
            }
        }
    }
}

/* ---------------------------------------------------------- música pelo nó */

/// A música buscada pelo nó: o yt-dlp daqui (com o token daqui) e o áudio do IP daqui.
struct NodeMusic {
    data_dir: PathBuf,
    logs: Logs,
    http: reqwest::Client,
    clients: Clients,
    tools: tokio::sync::Mutex<Option<Tools>>,
    audio: Mutex<HashMap<String, Audio>>,
}

impl NodeMusic {
    fn new(data_dir: PathBuf, logs: Logs, http: reqwest::Client) -> Self {
        Self { data_dir, logs, http, clients: Clients::default(), tools: tokio::sync::Mutex::new(None), audio: Mutex::new(HashMap::new()) }
    }

    async fn tools(&self) -> Result<Tools, String> {
        let mut guard = self.tools.lock().await;
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
        let t = crate::music::tools::provision(&self.http, &self.data_dir, &self.logs).await?;
        *guard = Some(t.clone());
        Ok(t)
    }

    async fn resolve_key(&self, key: &str, source: &Source, force: bool) -> Result<Audio, String> {
        if !force {
            if let Some(a) = self.audio.lock().unwrap().get(key).filter(|a| a.fetched.elapsed() < AUDIO_TTL).cloned() {
                return Ok(a);
            }
        }
        let tools = self.tools().await?;
        let audio = crate::music::stream::resolve_playable(&tools, &self.clients, &self.logs, source).await?;
        let mut cache = self.audio.lock().unwrap();
        cache.retain(|_, a| a.fetched.elapsed() < AUDIO_TTL);
        cache.insert(key.to_string(), audio.clone());
        Ok(audio)
    }

    async fn resolve(&self, d: &Value) -> Value {
        let key = d.get("key").and_then(Value::as_str).unwrap_or_default();
        let Some(source) = d.get("source").cloned().and_then(|v| serde_json::from_value::<Source>(v).ok()) else {
            return json!({ "error": "faixa inválida" });
        };
        if key.is_empty() {
            return json!({ "error": "faixa inválida" });
        }
        match self.resolve_key(key, &source, false).await {
            Ok(a) => json!({ "ok": true, "durationMs": a.duration_ms }),
            Err(e) => json!({ "error": e }),
        }
    }

    /// Busca o áudio e manda ao principal por um WebSocket aberto daqui (`/api/media/stream/{ticket}`).
    async fn fetch(&self, base: &str, d: &Value) {
        let ticket = d.get("ticket").and_then(Value::as_str).unwrap_or_default();
        let key = d.get("key").and_then(Value::as_str).unwrap_or_default();
        let range = d.get("range").and_then(Value::as_str).map(str::to_string);
        let source = d.get("source").cloned().and_then(|v| serde_json::from_value::<Source>(v).ok());
        if ticket.is_empty() || key.is_empty() || ticket.len() > 64 {
            return;
        }
        let response = async {
            let source = source.ok_or("faixa inválida")?;
            for attempt in 0..2 {
                let audio = self.resolve_key(key, &source, attempt > 0).await?;
                let mut req = self.clients.for_url(&audio.url).get(&audio.url);
                if let Some(r) = &range {
                    req = req.header(reqwest::header::RANGE, r);
                }
                let res = req.send().await.map_err(|e| e.to_string())?;
                // URL expirada ou recusada: resolve de novo uma vez.
                if matches!(res.status().as_u16(), 403 | 410) && attempt == 0 {
                    continue;
                }
                return Ok(res);
            }
            Err("o YouTube recusou o áudio".to_string())
        }
        .await;
        let url = format!("{base}/api/media/stream/{ticket}");
        let Ok(Ok((mut ws, _))) = tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url.as_str())).await else {
            self.logs.warn("Música pelo nó: não deu para entregar ao servidor");
            return;
        };
        let res = match response {
            Ok(r) => r,
            Err(e) => {
                let _ = ws.send(TMsg::Text(json!({ "status": 502, "error": e }).to_string().into())).await;
                let _ = ws.close(None).await;
                return;
            }
        };
        let mut headers = serde_json::Map::new();
        for name in ["content-type", "content-length", "content-range", "accept-ranges"] {
            if let Some(v) = res.headers().get(name).and_then(|v| v.to_str().ok()) {
                headers.insert(name.into(), json!(v));
            }
        }
        let head = json!({ "status": res.status().as_u16(), "headers": headers });
        if ws.send(TMsg::Text(head.to_string().into())).await.is_err() {
            return;
        }
        let mut body = res.bytes_stream();
        while let Some(chunk) = body.next().await {
            let Ok(chunk) = chunk else { break };
            // O `<audio>` parou de pedir (pulou na música, trocou de faixa): o principal fecha e paramos.
            if ws.send(TMsg::Binary(chunk)).await.is_err() {
                return;
            }
        }
        let _ = ws.close(None).await;
    }
}
