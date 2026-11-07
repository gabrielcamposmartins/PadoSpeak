//! Os nós de mídia, vistos pelo servidor principal: o SFU embutido (`LOCAL`) e os nós que ligaram pelo
//! canal de controle (`super::control`). Quem decide que sala vai para onde é o hub (`Hub::media_changed`);
//! aqui ficam quem está de pé, a carga de cada um e a ponte para mandar comandos.
use super::control::{Hello, DEAD_AFTER};
use super::load::Load;
use super::sfu::Sfu;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Id do SFU embutido no próprio servidor.
pub const LOCAL: &str = "local";
/// Um nó que caiu só volta a receber salas depois de ficar de pé por este tempo (sem ir e voltar).
pub const RETURN_AFTER: Duration = Duration::from_secs(30);
/// Um nó que acabou de ligar (pela primeira vez desde que o servidor subiu) recebe salas logo.
const FIRST_AFTER: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// `hello` com um nonce já visto neste intervalo é recusado (repetição).
const NONCE_WINDOW: Duration = Duration::from_secs(120);
pub const SETTINGS_KEY: &str = "media_settings";

/// O que o dono escolhe no painel (Painel → Mídia).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaSettings {
    /// Canais de voz passam para o SFU a partir de quantas pessoas.
    pub sfu_min_people: usize,
    /// SFU embutido neste servidor (a mesma máquina).
    pub embedded_sfu: bool,
    /// Pedir ao nó um token do YouTube para cada música.
    pub pot: bool,
    /// Buscar a música pelo nó: `auto` (o principal bloqueado ou sobrecarregado), `always` ou `off`.
    pub music_relay: String,
    /// Toda chamada pelo SFU, mesmo com uma ou duas pessoas e nas conversas privadas (quem não chega ao nó
    /// continua em malha com cada um, pela regra de cada par).
    pub sfu_always: bool,
}

impl Default for MediaSettings {
    fn default() -> Self {
        Self { sfu_min_people: 2, embedded_sfu: false, pot: true, music_relay: "auto".into(), sfu_always: false }
    }
}

impl MediaSettings {
    pub fn normalized(mut self) -> Self {
        self.sfu_min_people = self.sfu_min_people.clamp(2, 50);
        if !matches!(self.music_relay.as_str(), "auto" | "always" | "off") {
            self.music_relay = "auto".into();
        }
        self
    }
}

/// Um nó ligado pelo canal de controle.
struct Link {
    name: String,
    tx: UnboundedSender<String>,
    /// Qual conexão (um nó que religa substitui a anterior; o fim da antiga não derruba a nova).
    session: u64,
    caps: Vec<String>,
    version: String,
    public_ip: String,
    udp_port: u16,
    lan: Vec<String>,
    connected_at: i64,
    last_beat: Instant,
    eligible_at: Instant,
    load: Value,
    pending: HashMap<u64, oneshot::Sender<Value>>,
}

#[derive(Default)]
struct Inner {
    links: HashMap<String, Link>,
    local: Option<Arc<Sfu>>,
    /// Quando cada nó caiu pela última vez (desde que o servidor subiu).
    down_at: HashMap<String, Instant>,
    /// Prioridade de cada nó (do banco): menor primeiro.
    priority: HashMap<String, i64>,
    nonces: Vec<(String, Instant)>,
    /// Músicas buscadas pelo nó: o nó abre `/api/media/stream/{ticket}` e o proxy espera aqui.
    streams: HashMap<String, oneshot::Sender<axum::extract::ws::WebSocket>>,
}

pub struct Registry {
    inner: Mutex<Inner>,
    settings: RwLock<MediaSettings>,
    pub load: Arc<Load>,
    next_req: AtomicU64,
    next_session: AtomicU64,
}

/// Para quem vão os comandos do SFU de uma sala.
#[derive(Clone)]
pub enum Backend {
    Local(Arc<Sfu>),
    Remote(Arc<Registry>, String),
}

impl Backend {
    /// Comando sem resposta (`join`, `answer`, `want`, `leave`, `rekey`, `keyframe`).
    pub fn cmd(&self, op: &str, d: Value) {
        match self {
            Backend::Local(sfu) => super::apply_cmd(sfu, op, &d),
            Backend::Remote(reg, node) => reg.cmd(node, op, d),
        }
    }

    /// Oferta da conexão de envio → resposta do SFU (`{ sdp }` ou `{ error }`).
    pub async fn publish(&self, d: Value) -> Value {
        match self {
            Backend::Local(sfu) => super::publish(sfu, &d).await,
            Backend::Remote(reg, node) => reg.request(node, "publish", d).await.unwrap_or_else(|e| json!({ "error": e })),
        }
    }
}

/// Põe o id do nó no evento do SFU (`d.node`): o app sabe de qual ligação ele é.
pub fn tag_node(msg: &str, node: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(msg) else { return msg.to_string() };
    if let Some(d) = v.get_mut("d").and_then(Value::as_object_mut) {
        d.insert("node".into(), json!(node));
    }
    v.to_string()
}

impl Registry {
    pub fn new(settings: MediaSettings) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            settings: RwLock::new(settings.normalized()),
            load: Arc::new(Load::default()),
            next_req: AtomicU64::new(1),
            next_session: AtomicU64::new(1),
        })
    }

    pub fn settings(&self) -> MediaSettings {
        self.settings.read().unwrap().clone()
    }

    pub fn set_settings(&self, s: MediaSettings) {
        *self.settings.write().unwrap() = s.normalized();
    }

    /// `SFU_EMBEDDED=on|off` manda no SFU embutido (o painel mostra trancado).
    pub fn env_embedded() -> Option<bool> {
        let v = std::env::var("SFU_EMBEDDED").ok()?.trim().to_lowercase();
        match v.as_str() {
            "1" | "on" | "true" | "yes" => Some(true),
            "0" | "off" | "false" | "no" => Some(false),
            _ => None,
        }
    }

    pub fn wants_local(&self) -> bool {
        Self::env_embedded().unwrap_or_else(|| self.settings().embedded_sfu)
    }

    pub fn local(&self) -> Option<Arc<Sfu>> {
        self.inner.lock().unwrap().local.clone().filter(|s| s.is_running())
    }

    pub fn set_local(&self, sfu: Option<Arc<Sfu>>) {
        let old = std::mem::replace(&mut self.inner.lock().unwrap().local, sfu);
        if let Some(old) = old {
            old.shutdown();
        }
    }

    /// Testes: os nós ligados já podem receber salas.
    #[cfg(test)]
    pub fn make_ready(&self) {
        for l in self.inner.lock().unwrap().links.values_mut() {
            l.eligible_at = Instant::now();
        }
    }

    pub fn set_priorities(&self, map: HashMap<String, i64>) {
        self.inner.lock().unwrap().priority = map;
    }

    /// Nonce novo (não repetido) para um `hello`.
    pub fn fresh_nonce(&self, nonce: &str) -> bool {
        let mut s = self.inner.lock().unwrap();
        let now = Instant::now();
        s.nonces.retain(|(_, t)| now - *t < NONCE_WINDOW);
        if s.nonces.iter().any(|(n, _)| n == nonce) {
            return false;
        }
        s.nonces.push((nonce.to_string(), now));
        true
    }

    /* ---------------------------------------------------------- ciclo do canal de controle */

    /// O nó ligou (o `hello` conferiu): devolve a vez desta conexão.
    pub fn attach(&self, hello: &Hello, name: &str, public_ip: &str, tx: UnboundedSender<String>) -> u64 {
        let session = self.next_session.fetch_add(1, Ordering::Relaxed);
        let now = Instant::now();
        let mut s = self.inner.lock().unwrap();
        let wait = if s.down_at.contains_key(&hello.id) { RETURN_AFTER } else { FIRST_AFTER };
        let link = Link {
            name: name.to_string(),
            tx,
            session,
            caps: hello.caps.iter().take(8).cloned().collect(),
            version: hello.version.chars().take(20).collect(),
            public_ip: public_ip.to_string(),
            udp_port: hello.udp_port,
            lan: hello.lan.iter().take(8).cloned().collect(),
            connected_at: crate::now_ms(),
            last_beat: now,
            eligible_at: now + wait,
            load: Value::Null,
            pending: HashMap::new(),
        };
        s.links.insert(hello.id.clone(), link);
        session
    }

    /// A conexão do nó acabou. Devolve se era a atual (a sala dele precisa ir para outro lugar).
    pub fn detach(&self, id: &str, session: u64) -> bool {
        let mut s = self.inner.lock().unwrap();
        if s.links.get(id).is_none_or(|l| l.session != session) {
            return false;
        }
        s.links.remove(id);
        s.down_at.insert(id.to_string(), Instant::now());
        true
    }

    /// Tira o nó (removido ou desativado no painel): a conexão dele fecha.
    pub fn kick(&self, id: &str) {
        let mut s = self.inner.lock().unwrap();
        if s.links.remove(id).is_some() {
            s.down_at.insert(id.to_string(), Instant::now());
        }
    }

    pub fn beat(&self, id: &str, session: u64, load: Value) {
        let mut s = self.inner.lock().unwrap();
        if let Some(l) = s.links.get_mut(id).filter(|l| l.session == session) {
            l.last_beat = Instant::now();
            if !load.is_null() {
                l.load = load;
            }
        }
    }

    pub fn respond(&self, id: &str, req: u64, d: Value) {
        let mut s = self.inner.lock().unwrap();
        if let Some(tx) = s.links.get_mut(id).and_then(|l| l.pending.remove(&req)) {
            let _ = tx.send(d);
        }
    }

    /// O nó parou de bater (a conexão parece viva, mas não responde).
    pub fn stale(&self, id: &str, session: u64) -> bool {
        let s = self.inner.lock().unwrap();
        s.links.get(id).is_some_and(|l| l.session == session && l.last_beat.elapsed() > DEAD_AFTER)
    }

    /* ---------------------------------------------------------- escolha */

    /// O nó está de pé agora (o embutido: rodando; os outros: batendo).
    pub fn alive(&self, id: &str) -> bool {
        if id == LOCAL {
            return self.local().is_some();
        }
        let s = self.inner.lock().unwrap();
        s.links.get(id).is_some_and(|l| l.last_beat.elapsed() <= DEAD_AFTER)
    }

    fn remote_with(&self, cap: &str, eligible: bool) -> Vec<String> {
        let s = self.inner.lock().unwrap();
        let now = Instant::now();
        let mut list: Vec<(&String, &Link)> = s
            .links
            .iter()
            .filter(|(_, l)| l.last_beat.elapsed() <= DEAD_AFTER && l.caps.iter().any(|c| c == cap))
            .filter(|(_, l)| !eligible || now >= l.eligible_at)
            .collect();
        list.sort_by_key(|(id, _)| (s.priority.get(*id).copied().unwrap_or(0), (*id).clone()));
        list.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// O melhor lugar para uma sala nova (ou que precisa mudar): os nós remotos por prioridade, e o
    /// embutido por último. Com o principal sobrecarregado, o embutido só se não houver outro.
    pub fn pick_sfu(&self) -> Option<String> {
        if let Some(id) = self.remote_with("sfu", true).into_iter().next() {
            return Some(id);
        }
        self.local().map(|_| LOCAL.to_string())
    }

    /// Há um nó remoto de pé para receber salas (para tirar as do embutido quando o principal aperta).
    pub fn has_remote_sfu(&self) -> bool {
        !self.remote_with("sfu", true).is_empty()
    }

    pub fn overloaded(&self) -> bool {
        self.load.overloaded()
    }

    pub fn min_people(&self) -> usize {
        self.settings().sfu_min_people
    }

    /// "Sempre usar o SFU" (painel → Mídia).
    pub fn sfu_always(&self) -> bool {
        self.settings().sfu_always
    }

    pub fn backend(self: &Arc<Self>, id: &str) -> Option<Backend> {
        if id == LOCAL {
            return self.local().map(Backend::Local);
        }
        self.alive(id).then(|| Backend::Remote(self.clone(), id.to_string()))
    }

    /// Nó que dá o token do YouTube (`None`: sem token, a música segue como antes).
    pub fn pot_node(&self) -> Option<String> {
        if !self.settings().pot {
            return None;
        }
        self.remote_with("pot", false).into_iter().next()
    }

    /// Nó que busca a música no lugar do principal.
    pub fn music_node(&self) -> Option<String> {
        if self.settings().music_relay == "off" {
            return None;
        }
        self.remote_with("music", false).into_iter().next()
    }

    /* ---------------------------------------------------------- comandos */

    fn send(&self, id: &str, msg: String) -> bool {
        let s = self.inner.lock().unwrap();
        s.links.get(id).is_some_and(|l| l.tx.send(msg).is_ok())
    }

    pub fn cmd(&self, id: &str, op: &str, d: Value) {
        self.send(id, json!({ "t": "cmd", "op": op, "d": d }).to_string());
    }

    /// Pedido com resposta ao nó (`publish`; para `pot` e `music.resolve`, veja `request_for`).
    pub async fn request(&self, id: &str, op: &str, d: Value) -> Result<Value, String> {
        self.request_for(id, op, d, REQUEST_TIMEOUT).await
    }

    /// Como `request`, com o tempo de espera escolhido (gerar um token ou resolver uma música demora mais).
    pub async fn request_for(&self, id: &str, op: &str, d: Value, timeout: Duration) -> Result<Value, String> {
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut s = self.inner.lock().unwrap();
            let Some(link) = s.links.get_mut(id) else { return Err("O nó de mídia está fora do ar".into()) };
            link.pending.insert(req, tx);
            if link.tx.send(json!({ "t": "req", "id": req, "op": op, "d": d }).to_string()).is_err() {
                link.pending.remove(&req);
                return Err("O nó de mídia está fora do ar".into());
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err("O nó de mídia caiu no meio do pedido".into()),
            Err(_) => {
                if let Some(l) = self.inner.lock().unwrap().links.get_mut(id) {
                    l.pending.remove(&req);
                }
                Err("O nó de mídia não respondeu".into())
            }
        }
    }

    /* ---------------------------------------------------------- música pelo nó */

    /// Espera o nó abrir `/api/media/stream/{ticket}` com o áudio.
    pub fn expect_stream(&self, ticket: &str) -> oneshot::Receiver<axum::extract::ws::WebSocket> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().unwrap().streams.insert(ticket.to_string(), tx);
        rx
    }

    pub fn forget_stream(&self, ticket: &str) {
        self.inner.lock().unwrap().streams.remove(ticket);
    }

    /// O nó chegou com o áudio de um pedido: entrega a conexão a quem espera. `false`: ninguém esperava.
    pub fn deliver_stream(&self, ticket: &str, ws: axum::extract::ws::WebSocket) -> bool {
        let tx = self.inner.lock().unwrap().streams.remove(ticket);
        tx.is_some_and(|tx| tx.send(ws).is_ok())
    }

    pub fn awaits_stream(&self, ticket: &str) -> bool {
        self.inner.lock().unwrap().streams.contains_key(ticket)
    }

    /* ---------------------------------------------------------- painel */

    /// O estado ao vivo de cada nó ligado (o painel junta com a lista do banco).
    pub fn live(&self) -> HashMap<String, Value> {
        let s = self.inner.lock().unwrap();
        let now = Instant::now();
        s.links
            .iter()
            .map(|(id, l)| {
                (
                    id.clone(),
                    json!({
                        "name": l.name,
                        "online": l.last_beat.elapsed() <= DEAD_AFTER,
                        "ready": now >= l.eligible_at,
                        "caps": l.caps,
                        "version": l.version,
                        "publicIp": l.public_ip,
                        "udpPort": l.udp_port,
                        "lan": l.lan,
                        "connectedAt": l.connected_at,
                        "load": l.load,
                    }),
                )
            })
            .collect()
    }

    /// O SFU embutido, para o painel.
    pub fn local_view(&self) -> Value {
        match self.local() {
            Some(sfu) => json!({
                "running": true,
                "port": sfu.port,
                "peers": sfu.stats.peers.load(Ordering::Relaxed),
                "rooms": sfu.stats.rooms.load(Ordering::Relaxed),
            }),
            None => json!({ "running": false }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(id: &str, caps: &[&str]) -> Hello {
        Hello {
            id: id.into(),
            ts: 0,
            nonce: String::new(),
            mac: String::new(),
            version: "t".into(),
            caps: caps.iter().map(|c| c.to_string()).collect(),
            udp_port: 3479,
            lan: vec![],
        }
    }

    #[tokio::test]
    async fn escolhe_por_prioridade_e_espera_quem_caiu() {
        let reg = Registry::new(MediaSettings::default());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        assert_eq!(reg.pick_sfu(), None);
        let a = reg.attach(&hello("a", &["sfu", "pot"]), "A", "1.2.3.4", tx.clone());
        let _b = reg.attach(&hello("b", &["sfu"]), "B", "5.6.7.8", tx.clone());
        // Recém-ligados esperam `FIRST_AFTER` antes de receber salas.
        assert_eq!(reg.pick_sfu(), None);
        assert!(reg.alive("a"));
        for l in reg.inner.lock().unwrap().links.values_mut() {
            l.eligible_at = Instant::now();
        }
        reg.set_priorities(HashMap::from([("a".to_string(), 5), ("b".to_string(), 1)]));
        assert_eq!(reg.pick_sfu().as_deref(), Some("b"));
        assert_eq!(reg.pot_node().as_deref(), Some("a"));
        // Caiu e voltou: espera `RETURN_AFTER`.
        assert!(reg.detach("a", a));
        assert!(!reg.alive("a"));
        reg.attach(&hello("a", &["sfu"]), "A", "1.2.3.4", tx.clone());
        let wait = reg.inner.lock().unwrap().links["a"].eligible_at - Instant::now();
        assert!(wait > Duration::from_secs(25));
        // O fim de uma conexão antiga não derruba a nova.
        assert!(!reg.detach("a", a));
        assert!(reg.alive("a"));
    }

    #[test]
    fn nonce_repetido_e_recusado() {
        let reg = Registry::new(MediaSettings::default());
        assert!(reg.fresh_nonce("abc"));
        assert!(!reg.fresh_nonce("abc"));
        assert!(reg.fresh_nonce("abd"));
    }

    #[test]
    fn ajustes_ficam_dentro_dos_limites() {
        let s = MediaSettings { sfu_min_people: 0, music_relay: "talvez".into(), ..Default::default() }.normalized();
        assert_eq!(s.sfu_min_people, 2);
        assert_eq!(s.music_relay, "auto");
    }

    #[test]
    fn evento_leva_o_no() {
        let msg = tag_node(r#"{"ev":"sfu:offer","d":{"sdp":1}}"#, "n1");
        let v: Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(v["d"]["node"], "n1");
        assert_eq!(v["d"]["sdp"], 1);
    }
}
