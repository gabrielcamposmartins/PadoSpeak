//! SFU das chamadas (veio do HardLine): cada um manda o seu áudio, câmera e tela uma vez só para o nó de
//! mídia, e o nó repassa a quem quer receber. Na malha, quem transmite manda uma cópia para cada pessoa
//! (uma tela 1080p30 para 8 pessoas: ~48 Mbps de upload); aqui, o upload é o mesmo com 2 ou com 50.
//!
//! Roda no próprio servidor (embutido) ou num nó de mídia em outra máquina (`crate::media::node`); quem
//! decide que sala vai para onde é o servidor principal (`crate::media::registry` e `hub.rs`).
//!
//! WebRTC com o str0m (sans-IO, DTLS/SRTP em Rust puro), todo numa tarefa só, com um socket UDP só
//! (`SFU_UDP_PORT`). Cada pessoa tem duas conexões com o nó: a de envio (o app oferece, com o que está
//! mandando) e a de recebimento (o nó oferece, com o que ela quer receber). Assim nenhum dos lados
//! oferece ao mesmo tempo que o outro.
//!
//! - A voz de todos vai para todos; câmera e tela só para quem pediu (`sfu:want`), como na malha.
//! - A câmera vai em três camadas (simulcast `q`/`h`/`f`, de 1/4, 1/2 e a resolução inteira): cada um
//!   recebe a que pediu (quanto menor o quadro na tela, menor a camada) e, se ela parar de chegar (o
//!   navegador de quem envia corta as camadas de cima quando a internet aperta), a melhor que ainda chega.
//! - Quem envia sabe quantos assistem (`sfu:viewers`) e não manda o que ninguém vê.
//! - A mídia chega cifrada pelos próprios apps (veja `client/src/lib/mediaCrypt.js`): o nó só repassa.
//!   Os primeiros bytes de cada quadro de vídeo ficam abertos, e é por eles que o str0m reconhece o
//!   quadro-chave (troca de camada do simulcast).
//! - O canal de dados da conexão de recebimento leva um batimento a cada `BEAT_EVERY`: sem ele, o app
//!   percebe em menos de 1 s que o nó caiu e passa a voz para a malha de reserva.
//! - O nó é ICE-lite: só anuncia os próprios endereços e o app chega até ele (direto ou pelo TURN).
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::config::{CryptoProvider, DtlsCert};
use str0m::media::{Direction, KeyframeRequestKind, MediaData, MediaKind, MediaTime, Mid, Rid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Porta UDP do SFU quando nada diz outra (`SFU_UDP_PORT`).
pub const DEFAULT_UDP_PORT: u16 = 3479;
/// Batimento no canal de dados de cada conexão de recebimento (o app percebe a queda do nó por ele).
const BEAT_EVERY: Duration = Duration::from_millis(250);
/// Uma conexão sem caminho (ICE desconectado) por este tempo acabou: o app refaz.
const LOST_AFTER: Duration = Duration::from_secs(12);
/// Uma conexão que não conectou neste tempo não vai conectar.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(25);
/// Oferta do servidor sem resposta do app por este tempo: a conexão de recebimento é refeita.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// Pedidos de quadro-chave para a mesma camada, no máximo um a cada…
const KEYFRAME_EVERY: Duration = Duration::from_millis(500);
/// Uma camada do simulcast que não chega há este tempo deixou de ser enviada.
const LAYER_GONE: Duration = Duration::from_millis(1200);
/// Esperando o quadro-chave da camada nova há este tempo: vale o de qualquer camada que chegue.
const SWITCH_PATIENCE: Duration = Duration::from_millis(1500);
/// Quanto um quadro incompleto segura os seguintes. Dá tempo de a retransmissão chegar, mas é curto: com
/// pouca banda, ao sair um quadro-chave o navegador descarta o resto do quadro anterior sem deixar buraco
/// na numeração (não há o que pedir de novo), e no padrão da biblioteca (2 s) todos que assistem congelam.
const REORDER_WAIT: Duration = Duration::from_millis(200);
/// Pacotes lidos do socket antes de processar o que eles geraram.
const READ_BATCH: usize = 64;

/// `SFU_DEBUG=1`: registra as trocas de camada e os pedidos de quadro-chave.
fn debug() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("SFU_DEBUG").is_ok_and(|v| v != "0"))
}

/// Configuração: a porta UDP e os endereços que os apps usam para chegar ao SFU.
#[derive(Clone, Debug)]
pub struct SfuConfig {
    pub port: u16,
    /// Endereços anunciados aos apps (os públicos, se houver, e os da rede local). Só IPv4.
    pub ips: Vec<IpAddr>,
    /// Onde o socket escuta (padrão: todas as interfaces). `SFU_BIND=127.0.0.1`: só esta máquina (testes).
    pub bind: IpAddr,
}

/// `SFU_BIND`: o endereço em que o socket UDP escuta.
fn bind_ip() -> IpAddr {
    std::env::var("SFU_BIND").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

impl SfuConfig {
    /// `SFU_UDP_PORT`: a porta UDP (padrão 3479). `SFU_PUBLIC_IP`: os IPs pelos quais os apps chegam ao
    /// SFU (VM atrás de NAT, Docker, roteador com a porta redirecionada), além dos da rede local.
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let port = env("SFU_UDP_PORT").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_UDP_PORT);
        let ips: Vec<IpAddr> = env("SFU_PUBLIC_IP")
            .map(|v| v.split(',').filter_map(|ip| ip.trim().parse().ok()).collect())
            .unwrap_or_default();
        Self::new(port, ips)
    }

    /// `public` primeiro (na ordem), depois os da rede local; sem nenhum, só a própria máquina. Escutando
    /// só no laço local (`SFU_BIND`), só ele é anunciado.
    pub fn new(port: u16, public: Vec<IpAddr>) -> Self {
        let bind = bind_ip();
        if bind.is_loopback() {
            return Self { port, ips: vec![bind], bind };
        }
        let mut ips: Vec<IpAddr> = Vec::new();
        for ip in public.into_iter().chain(crate::tls::lan_addresses()) {
            if ip.is_ipv4() && !ip.is_unspecified() && !ips.contains(&ip) {
                ips.push(ip);
            }
        }
        if ips.is_empty() {
            ips.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
        }
        Self { port, ips, bind }
    }
}

/// O que o SFU está fazendo agora (para o batimento do nó e o painel).
#[derive(Default)]
pub struct SfuStats {
    pub peers: AtomicUsize,
    pub rooms: AtomicUsize,
    /// Bytes de mídia repassados (soma de todas as cópias que saíram).
    pub bytes_out: AtomicU64,
}

/// Uma trilha que o app está enviando (declarada junto com a oferta da conexão de envio).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PubTrack {
    pub mid: String,
    /// `mic`, `camera`, `screen` ou `screenAudio`.
    pub source: String,
    /// O stream do lado de quem envia: quem recebe reconhece a câmera e a tela por ele.
    #[serde(default)]
    pub stream_id: String,
}

/// O que eu quero receber de uma pessoa (a voz vem sempre).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Want {
    #[serde(default)]
    pub camera: bool,
    #[serde(default)]
    pub screen: bool,
    /// Camada da câmera: `q`, `h` ou `f` (padrão `h`).
    #[serde(default)]
    pub quality: Option<char>,
}

enum Cmd {
    Join { conn: String, room: String },
    Publish { conn: String, offer: SdpOffer, tracks: Vec<PubTrack>, reply: oneshot::Sender<Result<SdpAnswer, String>> },
    Answer { conn: String, answer: SdpAnswer },
    Want { conn: String, wants: HashMap<String, Want> },
    Leave { conn: String },
    Rekey { old: String, new: String },
    /// `conn` precisa de um quadro-chave dos vídeos de `from` (acabou de receber a chave para decifrá-los).
    Keyframe { conn: String, from: String },
    /// Os endereços anunciados mudaram (o nó soube do IP público dele): valem para as conexões novas.
    SetAddrs(Vec<IpAddr>),
}

/// Ponta do SFU usada pelo hub (embutido) ou pelo nó de mídia. Tudo vai por mensagem para a tarefa que
/// cuida das conexões.
pub struct Sfu {
    tx: UnboundedSender<Cmd>,
    pub port: u16,
    pub stats: Arc<SfuStats>,
    /// Desliga só este SFU (o embutido pode ser desligado pelo painel).
    stop: CancellationToken,
}

impl Sfu {
    /// Abre o socket UDP e sobe a tarefa. `out` recebe `(conexão, evento JSON)` para mandar pelo WebSocket.
    pub fn start(cfg: SfuConfig, out: UnboundedSender<(String, String)>, shutdown: &CancellationToken) -> Result<Arc<Self>, String> {
        let socket = bind(cfg.bind, cfg.port).map_err(|e| format!("porta UDP {}: {e}", cfg.port))?;
        let port = socket.local_addr().map_err(|e| e.to_string())?.port();
        let addrs: Vec<SocketAddr> = cfg.ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect();
        let provider = Arc::new(str0m::crypto::from_feature_flags());
        let cert = provider.dtls_provider.generate_certificate().ok_or("certificado DTLS")?;
        let (tx, rx) = unbounded_channel();
        let stats = Arc::new(SfuStats::default());
        let stop = shutdown.child_token();
        let state = State {
            socket,
            port,
            provider,
            cert,
            addrs,
            out,
            peers: HashMap::new(),
            by_conn: HashMap::new(),
            routes: HashMap::new(),
            next_pid: 1,
            touched: HashSet::new(),
            dirty: HashSet::new(),
            stats: stats.clone(),
            frames: FrameLog::default(),
            next_addrs: None,
        };
        tokio::spawn(run(state, rx, stop.clone()));
        Ok(Arc::new(Self { tx, port, stats, stop }))
    }

    /// Desliga o SFU (as conexões caem; os apps passam para a malha).
    pub fn shutdown(&self) {
        self.stop.cancel();
    }

    pub fn is_running(&self) -> bool {
        !self.stop.is_cancelled() && !self.tx.is_closed()
    }

    pub fn keyframe(&self, conn: &str, from: &str) {
        let _ = self.tx.send(Cmd::Keyframe { conn: conn.into(), from: from.into() });
    }

    pub fn set_addrs(&self, ips: Vec<IpAddr>) {
        let _ = self.tx.send(Cmd::SetAddrs(ips));
    }

    /// Começa (ou recomeça) a parte desta conexão no SFU: o servidor oferece a conexão de recebimento.
    pub fn join(&self, conn: &str, room: &str) {
        let _ = self.tx.send(Cmd::Join { conn: conn.into(), room: room.into() });
    }

    /// Oferta da conexão de envio: devolve a resposta.
    pub async fn publish(&self, conn: &str, offer: SdpOffer, tracks: Vec<PubTrack>) -> Result<SdpAnswer, String> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Cmd::Publish { conn: conn.into(), offer, tracks, reply }).map_err(|_| "SFU desligado".to_string())?;
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(r)) => r,
            _ => Err("O SFU não respondeu".into()),
        }
    }

    pub fn answer(&self, conn: &str, answer: SdpAnswer) {
        let _ = self.tx.send(Cmd::Answer { conn: conn.into(), answer });
    }

    pub fn want(&self, conn: &str, wants: HashMap<String, Want>) {
        let _ = self.tx.send(Cmd::Want { conn: conn.into(), wants });
    }

    pub fn leave(&self, conn: &str) {
        let _ = self.tx.send(Cmd::Leave { conn: conn.into() });
    }

    /// A mesma pessoa voltou com outra conexão (o WebSocket caiu e voltou): a mídia continua.
    pub fn rekey(&self, old: &str, new: &str) {
        let _ = self.tx.send(Cmd::Rekey { old: old.into(), new: new.into() });
    }
}

/// Socket UDP com buffers grandes: um quadro-chave de tela 1080p são centenas de pacotes de uma vez.
fn bind(ip: IpAddr, port: u16) -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, None)?;
    let _ = s.set_recv_buffer_size(4 << 20);
    let _ = s.set_send_buffer_size(4 << 20);
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::new(ip, port).into())?;
    UdpSocket::from_std(s.into())
}

fn event(ev: &str, d: Value) -> String {
    json!({ "ev": ev, "d": d }).to_string()
}

/* ------------------------------------------------------------------ estado */

type Pid = u64;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Side {
    Pub,
    Sub,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    Mic,
    Camera,
    Screen,
    ScreenAudio,
}

impl Source {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "mic" => Source::Mic,
            "camera" => Source::Camera,
            "screen" => Source::Screen,
            "screenAudio" => Source::ScreenAudio,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Source::Mic => "mic",
            Source::Camera => "camera",
            Source::Screen => "screen",
            Source::ScreenAudio => "screenAudio",
        }
    }
    fn kind(self) -> MediaKind {
        match self {
            Source::Mic | Source::ScreenAudio => MediaKind::Audio,
            Source::Camera | Source::Screen => MediaKind::Video,
        }
    }
}

/// Camadas do simulcast, da menor para a maior.
const LAYERS: [char; 3] = ['q', 'h', 'f'];

fn layer_index(rid: Rid) -> Option<usize> {
    let s = rid.to_string();
    let c = s.chars().next()?;
    LAYERS.iter().position(|l| *l == c)
}

struct Leg {
    rtc: Rtc,
    next: Instant,
    created: Instant,
    connected: bool,
    /// Desde quando está sem caminho (ICE desconectado).
    lost_since: Option<Instant>,
}

impl Leg {
    fn new(rtc: Rtc) -> Self {
        let now = Instant::now();
        Leg { rtc, next: now, created: now, connected: false, lost_since: None }
    }
}

/// Uma trilha que chega de quem envia.
struct TrackIn {
    mid: Mid,
    source: Source,
    stream_id: String,
    /// Último pedido de quadro-chave por camada (`None`: sem simulcast).
    keyframe_at: HashMap<Option<Rid>, Instant>,
    /// Quando cada camada do simulcast chegou pela última vez.
    seen: [Option<Instant>; 3],
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum OutState {
    ToOpen,
    Negotiating(Mid),
    Open(Mid),
    ToStop(Mid),
    NegotiatingStop(Mid),
}

/// Uma trilha que vai para quem recebe.
struct TrackOut {
    from: Pid,
    src: Mid,
    source: Source,
    stream_id: String,
    state: OutState,
    /// Camada pedida (câmera com simulcast).
    quality: usize,
    /// Camada que está sendo repassada.
    rid: Option<Rid>,
    /// Desde quando espera o quadro-chave de outra camada.
    switching: Option<Instant>,
    /// Ajuste do tempo RTP (as camadas têm relógios diferentes): o vídeo não pula na troca.
    offset: i64,
    last_time: Option<u64>,
}

impl TrackOut {
    fn mid(&self) -> Option<Mid> {
        match self.state {
            OutState::ToOpen => None,
            OutState::Negotiating(m) | OutState::Open(m) | OutState::ToStop(m) | OutState::NegotiatingStop(m) => Some(m),
        }
    }
    /// Ainda vai (ou já vai) para quem recebe.
    fn live(&self) -> bool {
        matches!(self.state, OutState::ToOpen | OutState::Negotiating(_) | OutState::Open(_))
    }
}

struct Peer {
    conn: String,
    room: String,
    publ: Option<Leg>,
    sub: Leg,
    tracks_in: Vec<TrackIn>,
    out: Vec<TrackOut>,
    pending: Option<(SdpPendingOffer, Instant)>,
    /// O canal de dados que garante que a conexão de recebimento sempre tem o que negociar.
    has_channel: bool,
    /// O mesmo canal, já aberto: leva o batimento (`BEAT_EVERY`).
    channel: Option<ChannelId>,
    beat_at: Instant,
    /// Por conexão de quem envia.
    wants: HashMap<String, Want>,
    viewers: (usize, usize),
}

impl Peer {
    fn leg(&mut self, side: Side) -> Option<&mut Leg> {
        match side {
            Side::Pub => self.publ.as_mut(),
            Side::Sub => Some(&mut self.sub),
        }
    }
}

/// `SFU_DEBUG_FRAMES=1`: de tempos em tempos, o byte mais comum no começo dos quadros de voz de cada um.
/// Voz aberta (Opus) começa quase sempre pelo mesmo byte (o TOC); cifrada, o primeiro byte é aleatório.
/// É assim que o teste confere que o nó não recebe a voz aberta.
#[derive(Default)]
struct FrameLog {
    first: HashMap<String, [u32; 256]>,
    at: Option<Instant>,
}

fn debug_frames() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("SFU_DEBUG_FRAMES").is_ok_and(|v| v != "0"))
}

impl FrameLog {
    fn note(&mut self, conn: &str, data: &[u8]) {
        let Some(b) = data.first() else { return };
        self.first.entry(conn.to_string()).or_insert([0; 256])[*b as usize] += 1;
        let now = Instant::now();
        if self.at.is_some_and(|t| now - t < Duration::from_secs(5)) {
            return;
        }
        self.at = Some(now);
        for (conn, counts) in std::mem::take(&mut self.first) {
            let total: u32 = counts.iter().sum();
            let (byte, top) = counts.iter().enumerate().max_by_key(|(_, n)| **n).map(|(b, n)| (b, *n)).unwrap_or((0, 0));
            if total > 0 {
                eprintln!("[sfu] quadros de voz de {conn}: {total}, byte inicial mais comum 0x{byte:02x} em {}%", top * 100 / total);
            }
        }
    }
}

struct State {
    socket: UdpSocket,
    port: u16,
    stats: Arc<SfuStats>,
    frames: FrameLog,
    /// Endereços novos esperando o SFU esvaziar (veja `Cmd::SetAddrs`).
    next_addrs: Option<Vec<SocketAddr>>,
    provider: Arc<CryptoProvider>,
    cert: DtlsCert,
    addrs: Vec<SocketAddr>,
    out: UnboundedSender<(String, String)>,
    peers: HashMap<Pid, Peer>,
    by_conn: HashMap<String, Pid>,
    /// De onde chegou o último pacote de cada conexão (para não perguntar a todas).
    routes: HashMap<SocketAddr, (Pid, Side)>,
    next_pid: Pid,
    /// Conexões que receberam algo e precisam ser processadas.
    touched: HashSet<(Pid, Side)>,
    /// Quem precisa conferir o que recebe (alguém entrou, saiu, começou a enviar ou mudou o pedido).
    dirty: HashSet<Pid>,
}

/// O que sai do processamento de uma conexão e afeta as outras.
enum Prop {
    Media(Pid, MediaData),
    Keyframe { origin: Pid, mid: Mid, rid: Option<Rid>, kind: KeyframeRequestKind },
    SubConnected(Pid),
}

async fn run(mut st: State, mut rx: UnboundedReceiver<Cmd>, shutdown: CancellationToken) {
    let mut buf = vec![0u8; 2048];
    loop {
        let wake = st.next_wake();
        tokio::select! {
            res = st.socket.recv_from(&mut buf) => {
                if let Ok((n, source)) = res {
                    st.receive(source, &buf[..n]);
                    // O que mais já chegou, antes de processar.
                    for _ in 1..READ_BATCH {
                        match st.socket.try_recv_from(&mut buf) {
                            Ok((n, source)) => st.receive(source, &buf[..n]),
                            Err(_) => break,
                        }
                    }
                }
            }
            cmd = rx.recv() => match cmd {
                Some(cmd) => st.command(cmd),
                None => break,
            },
            _ = tokio::time::sleep_until(wake.into()) => {}
            _ = shutdown.cancelled() => break,
        }
        let now = Instant::now();
        st.timeouts(now);
        st.beat(now);
        st.settle();
    }
    for p in st.peers.values_mut() {
        p.sub.rtc.disconnect();
        if let Some(l) = p.publ.as_mut() {
            l.rtc.disconnect();
        }
    }
}

impl State {
    fn rtc(&self) -> Rtc {
        let mut rtc = Rtc::builder()
            .set_ice_lite(true)
            .set_crypto_provider(self.provider.clone())
            .set_dtls_cert(self.cert.clone())
            // Só o que todos os navegadores decodificam: quem recebe precisa do mesmo codec de quem envia.
            .clear_codecs()
            .enable_opus(true, false)
            .enable_vp8(true)
            .enable_h264(true)
            .set_reordering_timeout_video(Some(REORDER_WAIT))
            .build(Instant::now());
        for addr in &self.addrs {
            if let Ok(c) = Candidate::host(*addr, "udp") {
                rtc.add_local_candidate(c);
            }
        }
        rtc
    }

    fn send(&self, conn: &str, ev: &str, d: Value) {
        let _ = self.out.send((conn.to_string(), event(ev, d)));
    }

    fn next_wake(&self) -> Instant {
        let mut wake = Instant::now() + Duration::from_millis(500);
        for p in self.peers.values() {
            wake = wake.min(p.sub.next);
            if let Some(l) = &p.publ {
                wake = wake.min(l.next);
            }
            if p.channel.is_some() {
                wake = wake.min(p.beat_at + BEAT_EVERY);
            }
        }
        wake
    }

    /// Batimento no canal de dados de quem já está recebendo.
    fn beat(&mut self, now: Instant) {
        for (pid, p) in self.peers.iter_mut() {
            let Some(id) = p.channel else { continue };
            if now - p.beat_at < BEAT_EVERY || !p.sub.connected {
                continue;
            }
            p.beat_at = now;
            if let Some(mut ch) = p.sub.rtc.channel(id) {
                let _ = ch.write(false, b"b");
                self.touched.insert((*pid, Side::Sub));
            }
        }
    }

    /* ---------------------------------------------------------- comandos */

    fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Join { conn, room } => {
                self.remove_conn(&conn);
                let pid = self.next_pid;
                self.next_pid += 1;
                let peer = Peer {
                    conn: conn.clone(),
                    room,
                    publ: None,
                    sub: Leg::new(self.rtc()),
                    tracks_in: Vec::new(),
                    out: Vec::new(),
                    pending: None,
                    has_channel: false,
                    channel: None,
                    beat_at: Instant::now(),
                    wants: HashMap::new(),
                    viewers: (0, 0),
                };
                self.peers.insert(pid, peer);
                self.by_conn.insert(conn, pid);
                self.dirty.insert(pid);
                self.count();
            }
            Cmd::Keyframe { conn, from } => {
                let (Some(&pid), Some(&origin)) = (self.by_conn.get(&conn), self.by_conn.get(&from)) else { return };
                let wanted: Vec<_> = self.peers[&pid]
                    .out
                    .iter()
                    .filter(|t| t.from == origin && matches!(t.state, OutState::Open(_)) && t.source.kind() == MediaKind::Video)
                    .map(|t| (t.src, t.rid))
                    .collect();
                for (mid, rid) in wanted {
                    self.request_keyframe(origin, mid, rid, KeyframeRequestKind::Pli);
                }
            }
            Cmd::SetAddrs(ips) => {
                // Escutando só no laço local, o endereço é sempre ele.
                if self.addrs.iter().all(|a| a.ip().is_loopback()) {
                    return;
                }
                let addrs: Vec<SocketAddr> = ips.into_iter().map(|ip| SocketAddr::new(ip, self.port)).collect();
                if addrs.is_empty() || addrs == self.addrs {
                    return;
                }
                // As conexões abertas anunciaram os endereços de antes (e o destino de cada pacote é o
                // primeiro deles): a troca espera o SFU esvaziar.
                if self.peers.is_empty() {
                    self.addrs = addrs;
                } else {
                    self.next_addrs = Some(addrs);
                }
            }
            Cmd::Publish { conn, offer, tracks, reply } => {
                let _ = reply.send(self.publish(&conn, offer, tracks));
            }
            Cmd::Answer { conn, answer } => {
                let Some(&pid) = self.by_conn.get(&conn) else { return };
                let peer = self.peers.get_mut(&pid).unwrap();
                let Some((pending, _)) = peer.pending.take() else { return };
                if let Err(e) = peer.sub.rtc.sdp_api().accept_answer(pending, answer) {
                    eprintln!("[sfu] resposta recusada ({}): {e}", peer.conn);
                    self.lose(pid);
                    return;
                }
                let mut opened = Vec::new();
                for t in &mut peer.out {
                    match t.state {
                        OutState::Negotiating(m) => {
                            t.state = OutState::Open(m);
                            if t.source.kind() == MediaKind::Video {
                                opened.push((t.from, t.src, t.rid));
                            }
                        }
                        OutState::NegotiatingStop(_) => {}
                        _ => {}
                    }
                }
                peer.out.retain(|t| !matches!(t.state, OutState::NegotiatingStop(_)));
                self.touched.insert((pid, Side::Sub));
                self.dirty.insert(pid);
                // Quem acabou de começar a receber um vídeo precisa de um quadro-chave para ver algo.
                for (from, mid, rid) in opened {
                    self.request_keyframe(from, mid, rid, KeyframeRequestKind::Pli);
                }
            }
            Cmd::Want { conn, wants } => {
                let Some(&pid) = self.by_conn.get(&conn) else { return };
                self.peers.get_mut(&pid).unwrap().wants = wants;
                self.dirty.insert(pid);
            }
            Cmd::Leave { conn } => self.remove_conn(&conn),
            Cmd::Rekey { old, new } => {
                let Some(pid) = self.by_conn.remove(&old) else { return };
                self.remove_conn(&new);
                self.by_conn.insert(new.clone(), pid);
                let room = {
                    let p = self.peers.get_mut(&pid).unwrap();
                    p.conn = new.clone();
                    p.room.clone()
                };
                for (id, p) in self.peers.iter_mut() {
                    if let Some(w) = p.wants.remove(&old) {
                        p.wants.insert(new.clone(), w);
                    }
                    if p.room == room {
                        self.dirty.insert(*id);
                    }
                }
            }
        }
    }

    fn publish(&mut self, conn: &str, offer: SdpOffer, tracks: Vec<PubTrack>) -> Result<SdpAnswer, String> {
        let pid = *self.by_conn.get(conn).ok_or("Entre no SFU antes de enviar")?;
        let fresh = self.peers[&pid].publ.is_none().then(|| self.rtc());
        let peer = self.peers.get_mut(&pid).unwrap();
        if let Some(rtc) = fresh {
            peer.publ = Some(Leg::new(rtc));
        }
        let leg = peer.publ.as_mut().unwrap();
        let answer = leg.rtc.sdp_api().accept_offer(offer).map_err(|e| format!("Oferta recusada: {e}"))?;
        // As trilhas declaradas que existem de fato (e são do tipo certo), mantendo o que já se sabia delas.
        let mut old: Vec<TrackIn> = std::mem::take(&mut peer.tracks_in);
        for t in tracks {
            let Some(source) = Source::parse(&t.source) else { continue };
            let mid = Mid::from(t.mid.as_str());
            let Some(media) = leg.rtc.media(mid) else { continue };
            if media.kind() != source.kind() || !matches!(media.direction(), Direction::RecvOnly | Direction::SendRecv) {
                continue;
            }
            let stream_id: String = t.stream_id.chars().take(100).collect();
            let kept = old.iter().position(|o| o.mid == mid && o.source == source && o.stream_id == stream_id);
            peer.tracks_in.push(match kept {
                Some(i) => old.swap_remove(i),
                None => TrackIn { mid, source, stream_id, keyframe_at: HashMap::new(), seen: [None; 3] },
            });
        }
        let room = peer.room.clone();
        self.touched.insert((pid, Side::Pub));
        for (id, p) in &self.peers {
            if p.room == room && *id != pid {
                self.dirty.insert(*id);
            }
        }
        Ok(answer)
    }

    /// Tira a conexão do SFU (saiu da chamada ou vai recomeçar). Quem recebia dela deixa de receber.
    fn remove_conn(&mut self, conn: &str) {
        let Some(pid) = self.by_conn.remove(conn) else { return };
        let Some(mut peer) = self.peers.remove(&pid) else { return };
        peer.sub.rtc.disconnect();
        if let Some(l) = peer.publ.as_mut() {
            l.rtc.disconnect();
        }
        self.routes.retain(|_, (p, _)| *p != pid);
        self.touched.retain(|(p, _)| *p != pid);
        self.dirty.remove(&pid);
        for (id, p) in &self.peers {
            if p.room == peer.room {
                self.dirty.insert(*id);
            }
        }
        if self.peers.is_empty() {
            if let Some(addrs) = self.next_addrs.take() {
                self.addrs = addrs;
            }
        }
        self.count();
    }

    /// Pessoas e salas agora (para o batimento do nó).
    fn count(&self) {
        let rooms: HashSet<&str> = self.peers.values().map(|p| p.room.as_str()).collect();
        self.stats.peers.store(self.peers.len(), Ordering::Relaxed);
        self.stats.rooms.store(rooms.len(), Ordering::Relaxed);
    }

    /// Uma conexão morreu (sem caminho, oferta sem resposta): o app recomeça do zero.
    fn lose(&mut self, pid: Pid) {
        let Some(conn) = self.peers.get(&pid).map(|p| p.conn.clone()) else { return };
        self.remove_conn(&conn);
        self.send(&conn, "sfu:lost", json!({}));
    }

    /* ---------------------------------------------------------- rede */

    fn receive(&mut self, source: SocketAddr, data: &[u8]) {
        let Ok(contents) = data.try_into() else { return };
        // ICE-lite com um socket só: o destino é sempre o primeiro endereço anunciado.
        let input = Input::Receive(
            Instant::now(),
            Receive { proto: Protocol::Udp, source, destination: self.addrs[0], contents },
        );
        let cached = self.routes.get(&source).copied().filter(|(pid, side)| {
            self.peers.get(pid).and_then(|p| match side {
                Side::Pub => p.publ.as_ref(),
                Side::Sub => Some(&p.sub),
            })
            .is_some_and(|l| l.rtc.accepts(&input))
        });
        let found = cached.or_else(|| {
            self.peers.iter().find_map(|(pid, p)| {
                if p.sub.rtc.accepts(&input) {
                    Some((*pid, Side::Sub))
                } else if p.publ.as_ref().is_some_and(|l| l.rtc.accepts(&input)) {
                    Some((*pid, Side::Pub))
                } else {
                    None
                }
            })
        });
        let Some((pid, side)) = found else { return };
        self.routes.insert(source, (pid, side));
        let leg = self.peers.get_mut(&pid).and_then(|p| p.leg(side)).unwrap();
        if leg.rtc.handle_input(input).is_err() {
            leg.rtc.disconnect();
        }
        self.touched.insert((pid, side));
    }

    fn timeouts(&mut self, now: Instant) {
        let mut dead = Vec::new();
        for (pid, p) in self.peers.iter_mut() {
            let answer_late = p.pending.as_ref().is_some_and(|(_, at)| now - *at > ANSWER_TIMEOUT);
            for side in [Side::Pub, Side::Sub] {
                let Some(leg) = p.leg(side) else { continue };
                let gone = !leg.rtc.is_alive()
                    || leg.lost_since.is_some_and(|t| now - t > LOST_AFTER)
                    || (!leg.connected && now - leg.created > CONNECT_TIMEOUT);
                if gone {
                    dead.push(*pid);
                } else if leg.next <= now {
                    if leg.rtc.handle_input(Input::Timeout(now)).is_err() {
                        leg.rtc.disconnect();
                    }
                    self.touched.insert((*pid, side));
                }
            }
            if answer_late {
                dead.push(*pid);
            }
        }
        dead.dedup();
        for pid in dead {
            self.lose(pid);
        }
    }

    /// Processa tudo o que está pendente até não sobrar nada.
    fn settle(&mut self) {
        for _ in 0..64 {
            if self.touched.is_empty() && self.dirty.is_empty() {
                break;
            }
            for pid in std::mem::take(&mut self.dirty) {
                self.reconcile(pid);
            }
            let mut props = Vec::new();
            for (pid, side) in std::mem::take(&mut self.touched) {
                self.poll(pid, side, &mut props);
            }
            for p in props {
                self.apply(p);
            }
        }
        self.update_viewers();
    }

    /// Esvazia a saída de uma conexão: manda os pacotes e junta os eventos.
    fn poll(&mut self, pid: Pid, side: Side, props: &mut Vec<Prop>) {
        let Some(peer) = self.peers.get_mut(&pid) else { return };
        let Peer { publ, sub, out, conn, channel, .. } = peer;
        let leg = match side {
            Side::Pub => match publ.as_mut() {
                Some(l) => l,
                None => return,
            },
            Side::Sub => sub,
        };
        let now = Instant::now();
        loop {
            if !leg.rtc.is_alive() {
                leg.next = now;
                return;
            }
            let output = match leg.rtc.poll_output() {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("[sfu] {conn}: {e}");
                    leg.rtc.disconnect();
                    leg.next = now;
                    return;
                }
            };
            match output {
                Output::Transmit(t) => {
                    let _ = self.socket.try_send_to(&t.contents, t.destination);
                }
                Output::Timeout(t) => {
                    leg.next = t;
                    return;
                }
                Output::Event(e) => match e {
                    Event::Connected => {
                        leg.connected = true;
                        if side == Side::Sub {
                            props.push(Prop::SubConnected(pid));
                        }
                    }
                    Event::IceConnectionStateChange(s) => match s {
                        IceConnectionState::Disconnected => leg.lost_since = leg.lost_since.or(Some(now)),
                        IceConnectionState::Connected | IceConnectionState::Completed => leg.lost_since = None,
                        _ => {}
                    },
                    Event::ChannelOpen(id, _) if side == Side::Sub => *channel = Some(id),
                    Event::ChannelClose(id) if side == Side::Sub && *channel == Some(id) => *channel = None,
                    Event::MediaData(data) if side == Side::Pub => props.push(Prop::Media(pid, data)),
                    Event::KeyframeRequest(req) if side == Side::Sub => {
                        if let Some(t) = out.iter().find(|t| t.mid() == Some(req.mid)) {
                            props.push(Prop::Keyframe { origin: t.from, mid: t.src, rid: t.rid, kind: req.kind });
                        }
                    }
                    _ => {}
                },
            }
        }
    }

    fn apply(&mut self, p: Prop) {
        match p {
            Prop::Media(from, data) => self.forward(from, data),
            Prop::Keyframe { origin, mid, rid, kind } => self.request_keyframe(origin, mid, rid, kind),
            Prop::SubConnected(pid) => {
                // O que foi escrito antes de conectar se perdeu: um quadro-chave de cada vídeo.
                let wanted: Vec<_> = self.peers[&pid]
                    .out
                    .iter()
                    .filter(|t| matches!(t.state, OutState::Open(_)) && t.source.kind() == MediaKind::Video)
                    .map(|t| (t.from, t.src, t.rid))
                    .collect();
                for (from, mid, rid) in wanted {
                    self.request_keyframe(from, mid, rid, KeyframeRequestKind::Pli);
                }
            }
        }
    }

    fn request_keyframe(&mut self, origin: Pid, mid: Mid, rid: Option<Rid>, kind: KeyframeRequestKind) {
        let Some(peer) = self.peers.get_mut(&origin) else { return };
        let Some(t) = peer.tracks_in.iter_mut().find(|t| t.mid == mid) else { return };
        let now = Instant::now();
        // Simulcast sem camada escolhida ainda: pede de todas as que chegam.
        if rid.is_none() && t.seen.iter().any(Option::is_some) {
            let rids: Vec<Rid> = (0..3).filter(|i| t.seen[*i].is_some()).map(|i| Rid::from(LAYERS[i].to_string().as_str())).collect();
            for r in rids {
                self.request_keyframe(origin, mid, Some(r), kind);
            }
            return;
        }
        if t.keyframe_at.get(&rid).is_some_and(|at| now - *at < KEYFRAME_EVERY) {
            return;
        }
        let Some(mut writer) = peer.publ.as_mut().and_then(|l| l.rtc.writer(mid)) else { return };
        let possible = writer.is_request_keyframe_possible(kind);
        let res = if possible { writer.request_keyframe(rid, kind) } else { Ok(()) };
        if debug() {
            eprintln!("[sfu] quadro-chave {kind:?} {} {mid} {rid:?}: possível={possible} {res:?}", peer.conn);
        }
        if possible && res.is_ok() {
            t.keyframe_at.insert(rid, now);
            self.touched.insert((origin, Side::Pub));
        }
    }

    /// Repassa um pedaço de mídia de quem envia a todos da sala que estão recebendo aquela trilha.
    fn forward(&mut self, from: Pid, data: MediaData) {
        let now = Instant::now();
        let Some(origin) = self.peers.get_mut(&from) else { return };
        let room = origin.room.clone();
        let Some(track) = origin.tracks_in.iter_mut().find(|t| t.mid == data.mid) else { return };
        if debug_frames() && track.source == Source::Mic {
            self.frames.note(&origin.conn, &data.data);
        }
        let layer = data.rid.and_then(layer_index);
        if let Some(i) = layer {
            track.seen[i] = Some(now);
        }
        let seen = track.seen;
        let mut keyframes: Vec<(Mid, Option<Rid>, KeyframeRequestKind)> = Vec::new();
        // Depois de um buraco só um quadro-chave recomeça a imagem; se este já for um, não pede outro.
        if !data.contiguous && !data.is_keyframe() {
            keyframes.push((data.mid, data.rid, KeyframeRequestKind::Fir));
        }
        for (pid, peer) in self.peers.iter_mut() {
            if *pid == from || peer.room != room {
                continue;
            }
            for t in peer.out.iter_mut() {
                let OutState::Open(out_mid) = t.state else { continue };
                if t.from != from || t.src != data.mid {
                    continue;
                }
                if let Some(i) = layer {
                    // Simulcast: a camada pedida, ou a melhor abaixo dela que ainda chega (senão a menor acima).
                    let alive = |j: usize| seen[j].is_some_and(|s| now - s < LAYER_GONE);
                    let target = (0..=t.quality).rev().find(|j| alive(*j)).or_else(|| (t.quality..3).find(|j| alive(*j))).unwrap_or(i);
                    let current = t.rid.and_then(layer_index);
                    if current != Some(target) {
                        let patient = t.switching.is_some_and(|s| now - s > SWITCH_PATIENCE) || current.is_none_or(|c| !alive(c));
                        if debug() && data.is_keyframe() {
                            eprintln!("[sfu] {} quer {target} tem {current:?}; quadro-chave da camada {i} (paciente={patient})", peer.conn);
                        }
                        if data.is_keyframe() && (i == target || (patient && current != Some(i))) {
                            // Troca de camada, num quadro-chave, sem pular o tempo.
                            if let Some(last) = t.last_time {
                                t.offset = last as i64 + (data.time.frequency().get() / 30) as i64 - data.time.numer() as i64;
                            }
                            t.rid = data.rid;
                            t.switching = None;
                        } else {
                            // Pede de novo enquanto não vem (o pedido é limitado a um a cada `KEYFRAME_EVERY`).
                            t.switching.get_or_insert(now);
                            keyframes.push((data.mid, Some(Rid::from(LAYERS[target].to_string().as_str())), KeyframeRequestKind::Pli));
                        }
                    }
                    if t.rid != data.rid {
                        continue;
                    }
                }
                let time = (data.time.numer() as i64 + t.offset).max(0) as u64;
                t.last_time = Some(time);
                let Some(writer) = peer.sub.rtc.writer(out_mid) else { continue };
                let Some(pt) = writer.match_params(data.params) else { continue };
                if writer.write(pt, data.network_time, MediaTime::new(time, data.time.frequency()), data.data.clone()).is_ok() {
                    self.stats.bytes_out.fetch_add(data.data.len() as u64, Ordering::Relaxed);
                    self.touched.insert((*pid, Side::Sub));
                }
            }
        }
        for (mid, rid, kind) in keyframes {
            self.request_keyframe(from, mid, rid, kind);
        }
    }

    /* ---------------------------------------------------------- negociação */

    /// Confere o que `pid` deve receber e, se mudou, oferece a conexão de recebimento de novo.
    fn reconcile(&mut self, pid: Pid) {
        let Some(me) = self.peers.get(&pid) else { return };
        // (de quem, trilha, fonte, stream, camada pedida)
        let mut desired: Vec<(Pid, Mid, Source, String, usize)> = Vec::new();
        for (id, p) in &self.peers {
            if *id == pid || p.room != me.room || p.publ.is_none() {
                continue;
            }
            let want = me.wants.get(&p.conn).copied().unwrap_or_default();
            let quality = want.quality.and_then(|q| LAYERS.iter().position(|l| *l == q)).unwrap_or(1);
            for t in &p.tracks_in {
                let ok = match t.source {
                    Source::Mic => true,
                    Source::Camera => want.camera,
                    Source::Screen | Source::ScreenAudio => want.screen,
                };
                if ok {
                    desired.push((*id, t.mid, t.source, t.stream_id.clone(), quality));
                }
            }
        }
        let me = self.peers.get_mut(&pid).unwrap();
        let same = |t: &TrackOut, d: &(Pid, Mid, Source, String, usize)| t.from == d.0 && t.src == d.1 && t.source == d.2 && t.stream_id == d.3;
        me.out.retain(|t| t.state != OutState::ToOpen || desired.iter().any(|d| same(t, d)));
        for t in me.out.iter_mut() {
            if let OutState::Open(m) = t.state {
                if !desired.iter().any(|d| same(t, d)) {
                    t.state = OutState::ToStop(m);
                }
            }
        }
        for d in desired {
            match me.out.iter_mut().find(|t| t.live() && same(t, &d)) {
                Some(t) => t.quality = d.4,
                None => me.out.push(TrackOut {
                    from: d.0,
                    src: d.1,
                    source: d.2,
                    stream_id: d.3,
                    state: OutState::ToOpen,
                    quality: d.4,
                    rid: None,
                    switching: None,
                    offset: 0,
                    last_time: None,
                }),
            }
        }
        if me.pending.is_some() {
            return;
        }
        let needs = !me.has_channel || me.out.iter().any(|t| matches!(t.state, OutState::ToOpen | OutState::ToStop(_)));
        if !needs {
            return;
        }
        let mut change = me.sub.rtc.sdp_api();
        if !me.has_channel {
            change.add_channel("hl".into());
        }
        for t in me.out.iter_mut() {
            match t.state {
                OutState::ToOpen => {
                    let mid = change.add_media(t.source.kind(), Direction::SendOnly, Some(t.stream_id.clone()), None, None);
                    t.state = OutState::Negotiating(mid);
                }
                OutState::ToStop(m) => {
                    change.stop_media(m);
                    t.state = OutState::NegotiatingStop(m);
                }
                _ => {}
            }
        }
        let Some((offer, pending)) = change.apply() else { return };
        me.has_channel = true;
        me.pending = Some((pending, Instant::now()));
        // Quem recebe precisa saber de quem é cada trilha (pelo mid do transceiver).
        let conns: HashMap<Pid, String> = self.peers.iter().map(|(id, p)| (*id, p.conn.clone())).collect();
        let me = &self.peers[&pid];
        let tracks: serde_json::Map<String, Value> = me
            .out
            .iter()
            .filter_map(|t| match t.state {
                OutState::Negotiating(m) | OutState::Open(m) => Some((
                    m.to_string(),
                    json!({ "peerId": conns.get(&t.from), "source": t.source.name(), "streamId": t.stream_id }),
                )),
                _ => None,
            })
            .collect();
        let offer = serde_json::to_value(&offer).unwrap_or(Value::Null);
        self.send(&me.conn, "sfu:offer", json!({ "sdp": offer, "tracks": tracks }));
        self.touched.insert((pid, Side::Sub));
    }

    /// Avisa quem envia quantos estão recebendo a câmera e a tela dele.
    fn update_viewers(&mut self) {
        let mut counts: HashMap<Pid, (usize, usize)> = HashMap::new();
        for p in self.peers.values() {
            for t in p.out.iter().filter(|t| t.live()) {
                let c = counts.entry(t.from).or_default();
                match t.source {
                    Source::Camera => c.0 += 1,
                    Source::Screen => c.1 += 1,
                    _ => {}
                }
            }
        }
        let mut notes = Vec::new();
        for (id, p) in self.peers.iter_mut() {
            let now = counts.get(id).copied().unwrap_or_default();
            if now != p.viewers {
                p.viewers = now;
                notes.push((p.conn.clone(), now));
            }
        }
        for (conn, (camera, screen)) in notes {
            self.send(&conn, "sfu:viewers", json!({ "camera": camera, "screen": screen }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camadas_do_simulcast() {
        assert_eq!(layer_index(Rid::from("q")), Some(0));
        assert_eq!(layer_index(Rid::from("f")), Some(2));
        assert_eq!(layer_index(Rid::from("x")), None);
    }

    #[test]
    fn fontes() {
        assert_eq!(Source::parse("screenAudio").map(Source::kind), Some(MediaKind::Audio));
        assert_eq!(Source::parse("camera").map(Source::name), Some("camera"));
        assert!(Source::parse("outra").is_none());
    }
}
