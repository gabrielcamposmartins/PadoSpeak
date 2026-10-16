//! Tempo real via WebSocket: chat, presença, estado de voz e sinalização WebRTC (malha P2P).
//!
//! Protocolo (JSON):
//! - cliente → servidor: `{ "op": "...", "d": {...}, "id": 1 }` (`id` opcional; se presente há resposta)
//! - resposta:           `{ "re": 1, "d": {...} }`
//! - evento:             `{ "ev": "...", "d": {...} }`
use crate::api::{channel_with_access, guild_ids_of};
use crate::host::App;
use crate::models::{group_reactions, plain_text, reply_preview, user_from_row, Message, Reaction, ReplyRef, User, USER_COLS};
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_util::sync::CancellationToken;

type ConnId = String;

struct Conn {
    tx: UnboundedSender<String>,
    user_id: String,
    guilds: HashSet<String>,
    /// Amigos aceitos: também recebem a presença deste usuário.
    friends: HashSet<String>,
    /// O app está na tela (aba visível / app em primeiro plano). Sem nenhuma assim, vai push.
    visible: bool,
    /// Rede de onde a conexão vem (IP público, ou o prefixo /64 no IPv6): quem divide a mesma
    /// rede pode se encontrar ("Na sua rede").
    net: Net,
    /// Aceitou aparecer para quem está na mesma rede (`lan:hello`), e como o aparelho se descreve.
    nearby: bool,
    device: String,
    /// Sessão do app (painel do administrador): conta quanto tempo ficou aberto.
    session: Option<i64>,
}

/// De onde a conexão vem, para achar aparelhos na mesma rede.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Net {
    pub key: String,
    /// A mesma chave já garante a mesma rede local (IPv6 /64 ou endereço privado). No IPv4 público,
    /// várias casas podem dividir o IP (CGNAT): o app confirma com uma conexão direta.
    pub direct: bool,
}

impl Net {
    pub fn from_ip(ip: IpAddr) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(v4) if v4.is_private() || v4.is_loopback() || v4.is_link_local() => {
                let [a, b, c, _] = v4.octets();
                Net { key: format!("4l:{a}.{b}.{c}"), direct: true }
            }
            IpAddr::V4(v4) => Net { key: format!("4:{v4}"), direct: false },
            IpAddr::V6(v6) => {
                let seg = v6.segments();
                Net { key: format!("6:{:x}:{:x}:{:x}:{:x}", seg[0], seg[1], seg[2], seg[3]), direct: true }
            }
        }
    }
}

/// Endereço de quem conectou: atrás de um proxy na própria máquina/rede (nginx), vale o que ele
/// informa em `X-Real-IP`/`X-Forwarded-For`.
pub fn client_ip(addr: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let direct = addr.ip().to_canonical();
    let proxied = match direct {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    };
    if !proxied {
        return direct;
    }
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    header("x-real-ip")
        .or_else(|| header("x-forwarded-for").and_then(|v| v.split(',').next().map(|s| s.trim().to_string())))
        .and_then(|v| v.parse::<IpAddr>().ok())
        .unwrap_or(direct)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    peer_id: ConnId,
    user: User,
    /// Servidor do canal (vazio numa chamada direta): o cliente agrupa quem está na voz por servidor.
    #[serde(skip_serializing_if = "String::is_empty")]
    guild_id: String,
    /// Chamada 1 a 1: os dois usuários da conversa (em vez de uma guild).
    #[serde(skip)]
    dm_users: Option<[String; 2]>,
    muted: bool,
    deafened: bool,
    video: bool,
    screen: bool,
    camera_stream_id: Option<String>,
    screen_stream_id: Option<String>,
    /// Silenciado para todos por um moderador (os outros não ouvem a voz dele).
    server_muted: bool,
    /// Quando entrou no canal (para o registro saber quanto tempo ficou).
    #[serde(skip)]
    joined_at: i64,
}

#[derive(Default)]
struct HubState {
    conns: HashMap<ConnId, Conn>,
    user_conns: HashMap<String, HashSet<ConnId>>,
    /// canal de voz -> participantes (na ordem de entrada)
    voice: HashMap<String, Vec<Participant>>,
    conn_voice: HashMap<ConnId, String>,
    /// Avisa (o gerenciador de música) quando um canal de voz fica vazio.
    voice_empty_tx: Option<UnboundedSender<String>>,
    /// Status escolhido por quem está conectado (online, away, busy, invisible).
    statuses: HashMap<String, String>,
    /// O que cada um está fazendo agora ("Jogando …"), e a conexão que contou (o app do Windows).
    activities: HashMap<String, (Value, ConnId)>,
    /// Horários dos últimos "chamar atenção" de cada usuário (limite por minuto).
    nudges: HashMap<String, VecDeque<i64>>,
    /// Nó local: a presença vai para todos os conectados (perfil do PC e convidados da rede).
    lan_mode: bool,
    /// Canais privados → (servidor, quem pode ver). Canal fora daqui é público.
    restricted: HashMap<String, (String, HashSet<String>)>,
    /// Perfil de quem está conectado (para a lista de aparelhos na mesma rede).
    users: HashMap<String, User>,
    /// Registro dos servidores (entradas e saídas da voz).
    audit_tx: Option<crate::audit::Sender>,
}

pub const STATUSES: [&str; 4] = ["online", "away", "busy", "invisible"];
/// Máximo de "chamar atenção" por usuário a cada minuto.
const NUDGES_PER_MINUTE: usize = 3;
/// Aparelhos mostrados por rede (uma rede com muito mais que isso é um IP dividido por muita gente).
const NEARBY_MAX: usize = 30;

pub struct Hub {
    state: Mutex<HubState>,
    pub shutdown: CancellationToken,
}

fn event(ev: &str, d: impl Serialize) -> String {
    json!({ "ev": ev, "d": d }).to_string()
}

#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct HubStats {
    pub online_users: usize,
    pub connections: usize,
    pub voice_participants: usize,
    pub voice_channels_active: usize,
}

impl Hub {
    /// Cria o hub e o canal que recebe os ids dos canais de voz que ficaram vazios.
    pub fn new() -> (Arc<Self>, UnboundedReceiver<String>) {
        let (tx, rx) = unbounded_channel();
        let state = HubState { voice_empty_tx: Some(tx), ..Default::default() };
        (Arc::new(Self { state: Mutex::new(state), shutdown: CancellationToken::new() }), rx)
    }

    /// Liga o registro dos servidores (entradas e saídas da voz, com o tempo).
    pub fn set_audit(&self, tx: crate::audit::Sender) {
        self.state.lock().unwrap().audit_tx = Some(tx);
    }

    /// Alguém está no canal de voz agora?
    pub fn voice_has_people(&self, channel_id: &str) -> bool {
        self.state.lock().unwrap().voice.get(channel_id).is_some_and(|v| !v.is_empty())
    }

    /// Canal de voz (e guild) em que a conexão está.
    pub fn voice_channel_of(&self, conn_id: &str) -> Option<(String, String)> {
        let s = self.state.lock().unwrap();
        let channel_id = s.conn_voice.get(conn_id)?;
        let first = s.voice.get(channel_id)?.first()?;
        if first.dm_users.is_some() {
            return None;
        }
        Some((channel_id.clone(), first.guild_id.clone()))
    }

    pub fn stats(&self) -> HubStats {
        let s = self.state.lock().unwrap();
        HubStats {
            online_users: s.user_conns.len(),
            connections: s.conns.len(),
            voice_participants: s.voice.values().map(Vec::len).sum(),
            voice_channels_active: s.voice.len(),
        }
    }

    // ---------- Envio ----------

    fn send_to_guild(s: &HubState, guild_id: &str, msg: &str, except: Option<&str>) {
        for (id, c) in &s.conns {
            if c.guilds.contains(guild_id) && Some(id.as_str()) != except {
                let _ = c.tx.send(msg.to_string());
            }
        }
    }

    pub fn to_guild(&self, guild_id: &str, ev: &str, d: impl Serialize) {
        let s = self.state.lock().unwrap();
        Self::send_to_guild(&s, guild_id, &event(ev, d), None);
    }

    /// O usuário vê o canal? (canal público, ou ele está na lista do privado)
    fn can_see(s: &HubState, channel_id: &str, user_id: &str) -> bool {
        s.restricted.get(channel_id).map_or(true, |(_, users)| users.contains(user_id))
    }

    /// Como `send_to_guild`, mas um canal privado só chega a quem pode vê-lo.
    fn send_to_channel(s: &HubState, guild_id: &str, channel_id: &str, msg: &str, except: Option<&str>) {
        for (id, c) in &s.conns {
            if c.guilds.contains(guild_id) && Some(id.as_str()) != except && Self::can_see(s, channel_id, &c.user_id) {
                let _ = c.tx.send(msg.to_string());
            }
        }
    }

    pub fn to_channel(&self, guild_id: &str, channel_id: &str, ev: &str, d: impl Serialize) {
        let s = self.state.lock().unwrap();
        Self::send_to_channel(&s, guild_id, channel_id, &event(ev, d), None);
    }

    pub fn user_can_see(&self, channel_id: &str, user_id: &str) -> bool {
        Self::can_see(&self.state.lock().unwrap(), channel_id, user_id)
    }

    /// Troca a lista de canais privados (de um servidor, ou toda) e avisa quem perdeu a visão da voz.
    pub fn set_restricted(&self, guild_id: Option<&str>, map: HashMap<String, (String, HashSet<String>)>) {
        let mut s = self.state.lock().unwrap();
        match guild_id {
            Some(g) => {
                s.restricted.retain(|_, (gid, _)| gid != g);
                s.restricted.extend(map);
            }
            None => s.restricted = map,
        }
    }

    /// Tira da voz quem está num canal privado que não pode mais ver.
    pub fn kick_unallowed_voice(&self) {
        let mut s = self.state.lock().unwrap();
        let out: Vec<ConnId> = s
            .voice
            .iter()
            .flat_map(|(ch, list)| list.iter().map(move |p| (ch, p)))
            .filter(|(ch, p)| p.dm_users.is_none() && !Self::can_see(&s, ch, &p.user.id))
            .map(|(_, p)| p.peer_id.clone())
            .collect();
        for id in out {
            Self::kick_from_voice(&mut s, &id);
        }
    }

    fn send_to(s: &HubState, conn_id: &str, msg: String) {
        if let Some(c) = s.conns.get(conn_id) {
            let _ = c.tx.send(msg);
        }
    }

    fn send_to_user(s: &HubState, user_id: &str, msg: &str) {
        for id in s.user_conns.get(user_id).into_iter().flatten() {
            Self::send_to(s, id, msg.to_string());
        }
    }

    pub fn to_user(&self, user_id: &str, ev: &str, d: impl Serialize) {
        let s = self.state.lock().unwrap();
        Self::send_to_user(&s, user_id, &event(ev, d));
    }

    pub fn to_users(&self, user_ids: &[String], ev: &str, d: impl Serialize) {
        let s = self.state.lock().unwrap();
        let msg = event(ev, d);
        for u in user_ids {
            Self::send_to_user(&s, u, &msg);
        }
    }

    pub fn to_all(&self, ev: &str, d: impl Serialize) {
        let s = self.state.lock().unwrap();
        let msg = event(ev, d);
        for c in s.conns.values() {
            let _ = c.tx.send(msg.clone());
        }
    }

    /// Online para os outros: conectado e sem "aparecer offline".
/// A pessoa está com o PadoSpeak aberto na tela em algum aparelho?
    pub fn is_watching(&self, user_id: &str) -> bool {
        let s = self.state.lock().unwrap();
        s.user_conns.get(user_id).into_iter().flatten().any(|id| s.conns.get(id).is_some_and(|c| c.visible))
    }

    pub fn is_online(&self, user_id: &str) -> bool {
        Self::visible(&self.state.lock().unwrap(), user_id)
    }

    /// Usuários conectados e visíveis, com o status escolhido (anunciados na rede local).
    pub fn visible_users(&self) -> Vec<(String, String)> {
        let s = self.state.lock().unwrap();
        s.user_conns
            .keys()
            .filter(|u| Self::visible(&s, u))
            .map(|u| (u.clone(), s.statuses.get(u).cloned().unwrap_or_else(|| "online".into())))
            .collect()
    }

    /// Status visível para os outros (`None` quando offline ou invisível).
    pub fn presence_of(&self, user_id: &str) -> Option<String> {
        let s = self.state.lock().unwrap();
        Self::visible(&s, user_id).then(|| s.statuses.get(user_id).cloned().unwrap_or_else(|| "online".into()))
    }

    /// O usuário está (por alguma conexão) em algum destes servidores?
    fn shares_guild(s: &HubState, user_id: &str, guilds: &HashSet<String>) -> bool {
        s.user_conns
            .get(user_id)
            .into_iter()
            .flatten()
            .any(|id| s.conns.get(id).is_some_and(|c| !c.guilds.is_disjoint(guilds)))
    }

    /// Conta a `to` a presença atual de `about` (se estiver visível).
    fn tell_presence(s: &HubState, about: &str, to: &str) {
        if Self::visible(s, about) {
            let status = s.statuses.get(about).cloned().unwrap_or_else(|| "online".into());
            let activity = Self::activity_of(s, about);
            Self::send_to_user(
                s,
                to,
                &event("presence:update", json!({ "userId": about, "online": true, "status": status, "activity": activity })),
            );
        }
    }

    fn activity_of(s: &HubState, user_id: &str) -> Value {
        s.activities.get(user_id).map(|(a, _)| a.clone()).unwrap_or(Value::Null)
    }

    /// Troca a atividade ("Jogando …") de quem está conectado e avisa quem vê a presença dele.
    pub fn set_activity(&self, user_id: &str, conn_id: &str, activity: Option<Value>) {
        let mut s = self.state.lock().unwrap();
        let before = Self::activity_of(&s, user_id);
        match activity {
            Some(a) => s.activities.insert(user_id.to_string(), (a, conn_id.to_string())),
            None => s.activities.remove(user_id),
        };
        if Self::activity_of(&s, user_id) != before && Self::visible(&s, user_id) {
            let (guilds, friends) = Self::audience(&s, user_id);
            Self::presence(&s, user_id, true, guilds, &friends);
        }
    }

    fn visible(s: &HubState, user_id: &str) -> bool {
        s.user_conns.contains_key(user_id) && s.statuses.get(user_id).is_none_or(|st| st != "invisible")
    }

    /// Guilds e amigos de todas as conexões do usuário (quem deve saber da presença dele).
    fn audience(s: &HubState, user_id: &str) -> (HashSet<String>, HashSet<String>) {
        let (mut guilds, mut friends) = (HashSet::new(), HashSet::new());
        for id in s.user_conns.get(user_id).into_iter().flatten() {
            if let Some(c) = s.conns.get(id) {
                guilds.extend(c.guilds.iter().cloned());
                friends.extend(c.friends.iter().cloned());
            }
        }
        (guilds, friends)
    }

    /// Troca o status de quem está conectado e avisa quem precisa saber.
    /// Sair do invisível para online aparece para os outros como "ficou online".
    pub fn set_status(&self, user_id: &str, status: &str) {
        let mut s = self.state.lock().unwrap();
        let was = Self::visible(&s, user_id);
        s.statuses.insert(user_id.to_string(), status.to_string());
        let now = Self::visible(&s, user_id);
        if was || now {
            let (guilds, friends) = Self::audience(&s, user_id);
            Self::presence(&s, user_id, now, guilds, &friends);
        }
        Self::send_to_user(&s, user_id, &event("status:self", json!({ "status": status })));
    }

    /// Registra um "chamar atenção"; `Err(segundos)` se passou do limite por minuto.
    pub fn take_nudge(&self, user_id: &str) -> Result<(), i64> {
        let mut s = self.state.lock().unwrap();
        let now = crate::now_ms();
        let list = s.nudges.entry(user_id.to_string()).or_default();
        while list.front().is_some_and(|t| now - t >= 60_000) {
            list.pop_front();
        }
        if list.len() >= NUDGES_PER_MINUTE {
            return Err(((60_000 - (now - list[0])) + 999) / 1000);
        }
        list.push_back(now);
        Ok(())
    }

    /// Usuários conectados que veem a guild (exceto `except`).
    fn online_in_guild(&self, guild_id: &str, except: &str) -> Vec<String> {
        let s = self.state.lock().unwrap();
        let mut ids: HashSet<String> = HashSet::new();
        for (uid, conns) in &s.user_conns {
            if uid != except && conns.iter().any(|c| s.conns.get(c).is_some_and(|c| c.guilds.contains(guild_id))) {
                ids.insert(uid.clone());
            }
        }
        ids.into_iter().collect()
    }

    /// Atualiza a lista de amigos das conexões abertas (e avisa a presença quando viram amigos).
    pub fn set_friends(&self, a: &str, b: &str, friends: bool) {
        let mut s = self.state.lock().unwrap();
        for (me, other) in [(a, b), (b, a)] {
            let ids: Vec<ConnId> = s.user_conns.get(me).into_iter().flatten().cloned().collect();
            for id in ids {
                if let Some(c) = s.conns.get_mut(&id) {
                    if friends {
                        c.friends.insert(other.to_string());
                    } else {
                        c.friends.remove(other);
                    }
                }
            }
        }
        if friends {
            Self::tell_presence(&s, a, b);
            Self::tell_presence(&s, b, a);
        }
    }

    /// Canal de voz de servidor → todos da guild; chamada 1 a 1 → só os dois da conversa.
    fn broadcast_voice_channel(s: &HubState, scope: &Participant, channel_id: &str) {
        let participants = s.voice.get(channel_id).cloned().unwrap_or_default();
        let msg = event(
            "voice:channel",
            json!({ "guildId": scope.guild_id, "channelId": channel_id, "dm": scope.dm_users.is_some(), "participants": participants }),
        );
        match &scope.dm_users {
            Some(users) => users.iter().for_each(|u| Self::send_to_user(s, u, &msg)),
            None => Self::send_to_channel(s, &scope.guild_id, channel_id, &msg, None),
        }
    }

    /// Liga o modo do nó local (presença para todos).
    pub fn set_lan_mode(&self) {
        self.state.lock().unwrap().lan_mode = true;
    }

    fn presence(s: &HubState, user_id: &str, online: bool, guilds: impl IntoIterator<Item = String>, friends: &HashSet<String>) {
        let status = online.then(|| s.statuses.get(user_id).cloned().unwrap_or_else(|| "online".into()));
        let activity = if online { Self::activity_of(s, user_id) } else { Value::Null };
        let msg = event("presence:update", json!({ "userId": user_id, "online": online, "status": status, "activity": activity }));
        if s.lan_mode {
            for c in s.conns.values() {
                let _ = c.tx.send(msg.clone());
            }
            return;
        }
        for g in guilds {
            Self::send_to_guild(s, &g, &msg, None);
        }
        for f in friends {
            Self::send_to_user(s, f, &msg);
        }
    }

    // ---------- Aparelhos na mesma rede ----------

    /// Conta a cada aparelho visível da rede `net` quem mais está nela (menos ele mesmo).
    fn send_nearby(s: &HubState, net: &str) {
        if net.is_empty() {
            return;
        }
        let group: Vec<(&ConnId, &Conn)> =
            s.conns.iter().filter(|(_, c)| c.nearby && c.net.key == net).take(NEARBY_MAX).collect();
        for (id, c) in &group {
            let list: Vec<Value> = group
                .iter()
                .filter(|(other, oc)| other != id && oc.user_id != c.user_id)
                .filter_map(|(other, oc)| {
                    let user = s.users.get(&oc.user_id)?;
                    Some(json!({ "peerId": other, "user": user, "device": oc.device, "direct": oc.net.direct && c.net.direct }))
                })
                .collect();
            let _ = c.tx.send(event("lan:nearby", json!({ "peers": list })));
        }
    }

    // ---------- Voz ----------

    fn leave_voice_locked(s: &mut HubState, conn_id: &str) {
        let Some(channel_id) = s.conn_voice.remove(conn_id) else { return };
        let Some(list) = s.voice.get_mut(&channel_id) else { return };
        let Some(pos) = list.iter().position(|p| p.peer_id == conn_id) else { return };
        let me = list.remove(pos);
        let remaining: Vec<ConnId> = list.iter().map(|p| p.peer_id.clone()).collect();
        if me.dm_users.is_none() {
            if let Some(tx) = &s.audit_tx {
                let entry = crate::audit::Entry::new(&me.guild_id, "voice.leave", &me.user.id)
                    .channel(&channel_id)
                    .detail(json!({ "durationMs": crate::now_ms() - me.joined_at }));
                let _ = tx.send(entry);
            }
        }
        if list.is_empty() {
            s.voice.remove(&channel_id);
            if let Some(tx) = &s.voice_empty_tx {
                let _ = tx.send(channel_id.clone());
            }
        }
        let msg = event("voice:peer-left", json!({ "peerId": conn_id }));
        for peer in remaining {
            Self::send_to(s, &peer, msg.clone());
        }
        Self::broadcast_voice_channel(s, &me, &channel_id);
    }

    fn kick_from_voice(s: &mut HubState, conn_id: &str) {
        if let Some(channel_id) = s.conn_voice.get(conn_id).cloned() {
            Self::leave_voice_locked(s, conn_id);
            Self::send_to(s, conn_id, event("voice:kicked", json!({ "channelId": channel_id })));
        }
    }

    // ---------- Ponte para a API REST ----------

    pub fn join_guild(&self, user_id: &str, guild_id: &str) {
        let mut s = self.state.lock().unwrap();
        let ids: Vec<_> = s.user_conns.get(user_id).into_iter().flatten().cloned().collect();
        for id in &ids {
            if let Some(c) = s.conns.get_mut(id) {
                c.guilds.insert(guild_id.to_string());
            }
        }
        Self::presence(&s, user_id, Self::visible(&s, user_id), [guild_id.to_string()], &HashSet::new());
        let one = HashSet::from([guild_id.to_string()]);
        let members: Vec<String> =
            s.user_conns.keys().filter(|u| u.as_str() != user_id && Self::shares_guild(&s, u, &one)).cloned().collect();
        for m in members {
            Self::tell_presence(&s, &m, user_id);
        }
    }

    pub fn leave_guild(&self, user_id: &str, guild_id: &str) {
        let mut s = self.state.lock().unwrap();
        let ids: Vec<_> = s.user_conns.get(user_id).into_iter().flatten().cloned().collect();
        for id in ids {
            let in_guild = s
                .conn_voice
                .get(&id)
                .and_then(|ch| s.voice.get(ch))
                .is_some_and(|l| l.iter().any(|p| p.peer_id == id && p.guild_id == guild_id));
            if in_guild {
                Self::kick_from_voice(&mut s, &id);
            }
            if let Some(c) = s.conns.get_mut(&id) {
                c.guilds.remove(guild_id);
            }
        }
    }

    pub fn drop_guild(&self, guild_id: &str) {
        let mut s = self.state.lock().unwrap();
        let in_voice: Vec<ConnId> = s
            .voice
            .values()
            .flatten()
            .filter(|p| p.guild_id == guild_id)
            .map(|p| p.peer_id.clone())
            .collect();
        for id in in_voice {
            Self::kick_from_voice(&mut s, &id);
        }
        for c in s.conns.values_mut() {
            c.guilds.remove(guild_id);
        }
    }

    pub fn close_voice_channel(&self, channel_id: &str) {
        let mut s = self.state.lock().unwrap();
        let ids: Vec<ConnId> = s.voice.get(channel_id).into_iter().flatten().map(|p| p.peer_id.clone()).collect();
        for id in ids {
            Self::kick_from_voice(&mut s, &id);
        }
    }

    // ---------- Ciclo de vida da conexão ----------

    async fn run(self: Arc<Self>, app: Arc<App>, socket: WebSocket, user: User, net: Net) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = unbounded_channel::<String>();
        let conn_id: ConnId = uuid::Uuid::new_v4().simple().to_string();
        let guilds: HashSet<String> = guild_ids_of(&app, &user.id).await.into_iter().collect();
        let music = app.music.states_for(&guilds);
        let friends: HashSet<String> = crate::social::friend_ids(&app, &user.id).await.into_iter().collect();
        // STUN/TURN da configuração + o relay com senha temporária deste usuário.
        let mut ice_servers = app.config.ice_servers.clone();
        if let Some(turn) = &app.turn {
            ice_servers.push(turn.ice_server(&user.id, crate::now_ms()));
        }
        let my_status = app
            .db
            .query_one("SELECT status FROM users WHERE id = ?1", [user.id.as_str()], |r| r.get::<String>(0))
            .await
            .ok()
            .flatten()
            .filter(|st| STATUSES.contains(&st.as_str()))
            .unwrap_or_else(|| "online".into());

        {
            let mut s = self.state.lock().unwrap();
            let first = !s.user_conns.contains_key(&user.id);
            s.user_conns.entry(user.id.clone()).or_default().insert(conn_id.clone());
            s.statuses.insert(user.id.clone(), my_status.clone());
            // Estado inicial: usuários online e participantes de voz dos servidores deste usuário.
            let voice: HashMap<&String, &Vec<Participant>> = s
                .voice
                .iter()
                .filter(|(_, l)| {
                    l.first().is_some_and(|p| match &p.dm_users {
                        Some(users) => users.contains(&user.id),
                        None => guilds.contains(&p.guild_id),
                    })
                })
                .filter(|(ch, _)| Self::can_see(&s, ch, &user.id))
                .collect();
            let music: Vec<&Value> =
                music.iter().filter(|m| Self::can_see(&s, m["channelId"].as_str().unwrap_or_default(), &user.id)).collect();
            // Um host pode ter vários servidores: só aparece online quem divide um servidor comigo ou é
            // amigo (no nó local da rede, todos se veem).
            let online: Vec<&String> = s
                .user_conns
                .keys()
                .filter(|u| Self::visible(&s, u))
                .filter(|u| s.lan_mode || *u == &user.id || friends.contains(*u) || Self::shares_guild(&s, u, &guilds))
                .collect();
            let statuses: HashMap<&String, &String> =
                online.iter().filter_map(|u| s.statuses.get(*u).map(|st| (*u, st))).collect();
            let activities: HashMap<&String, &Value> =
                online.iter().filter_map(|u| s.activities.get(*u).map(|(a, _)| (*u, a))).collect();
            let _ = tx.send(event(
                "ready",
                json!({
                    "peerId": conn_id, "online": online, "statuses": statuses, "selfStatus": my_status,
                    "activities": activities, "voice": voice, "music": music, "serverTime": crate::now_ms(),
                    "iceServers": ice_servers
                }),
            ));
            s.users.insert(user.id.clone(), user.clone());
            s.conns.insert(
                conn_id.clone(),
                Conn {
                    tx: tx.clone(),
                    user_id: user.id.clone(),
                    guilds: guilds.clone(),
                    friends: friends.clone(),
                    visible: true,
                    net,
                    nearby: false,
                    device: String::new(),
                    session: None,
                },
            );
            if first && Self::visible(&s, &user.id) {
                Self::presence(&s, &user.id, true, guilds.iter().cloned(), &friends);
            }
        }

        let shutdown = self.shutdown.clone();
        let writer = tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = rx.recv() => match msg {
                        Some(text) => if sink.send(WsMessage::Text(text.into())).await.is_err() { break },
                        None => break,
                    },
                    _ = shutdown.cancelled() => {
                        let _ = sink.send(WsMessage::Close(None)).await;
                        break;
                    }
                }
            }
        });

        // A cada minuto, a sessão do app (painel do administrador) continua contando.
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        tick.tick().await;
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    let session = self.state.lock().unwrap().conns.get(&conn_id).and_then(|c| c.session);
                    if let Some(id) = session {
                        crate::admin::touch_session(&app, id).await;
                    }
                }
                msg = stream.next() => match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(req) = serde_json::from_str::<Request>(&text) {
                            if req.op == "music:add" {
                                self.spawn_music_add(&app, &conn_id, &user, req.d, req.id, tx.clone());
                                continue;
                            }
                            let reply = self.handle(&app, &conn_id, &user, req.op.as_str(), req.d).await;
                            if let (Some(id), Some(d)) = (req.id, reply) {
                                let _ = tx.send(json!({ "re": id, "d": d }).to_string());
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
                _ = self.shutdown.cancelled() => break,
            }
        }

        let session = self.state.lock().unwrap().conns.get(&conn_id).and_then(|c| c.session);
        if let Some(id) = session {
            crate::admin::touch_session(&app, id).await;
        }
        {
            let mut s = self.state.lock().unwrap();
            Self::leave_voice_locked(&mut s, &conn_id);
            if let Some(c) = s.conns.remove(&conn_id) {
                let now_offline = match s.user_conns.get_mut(&user.id) {
                    Some(set) => {
                        set.remove(&conn_id);
                        set.is_empty()
                    }
                    None => false,
                };
                // A atividade vinha desta conexão (o app do Windows fechou): some para os outros.
                let lost_activity = s.activities.get(&user.id).is_some_and(|(_, c)| c == &conn_id);
                if lost_activity {
                    s.activities.remove(&user.id);
                }
                if !now_offline && lost_activity && Self::visible(&s, &user.id) {
                    let (guilds, friends) = Self::audience(&s, &user.id);
                    Self::presence(&s, &user.id, true, guilds, &friends);
                }
                if now_offline {
                    let was_visible = Self::visible(&s, &user.id);
                    s.user_conns.remove(&user.id);
                    s.statuses.remove(&user.id);
                    s.activities.remove(&user.id);
                    if was_visible {
                        Self::presence(&s, &user.id, false, c.guilds.clone(), &c.friends);
                    }
                    s.users.remove(&user.id);
                }
                if c.nearby {
                    Self::send_nearby(&s, &c.net.key);
                }
            }
        }
        drop(tx);
        let _ = writer.await;
    }

    /// `music:add`: resolve o link e enfileira no canal de voz de quem enviou.
    fn spawn_music_add(&self, app: &Arc<App>, conn_id: &str, user: &User, d: Value, id: Option<u64>, tx: UnboundedSender<String>) {
        let place = self.voice_channel_of(conn_id);
        let (app, user) = (app.clone(), user.clone());
        tokio::spawn(async move {
            let url = d.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
            let reply = match place {
                None => json!({ "error": "Entre em um canal de voz para tocar música" }),
                Some((channel_id, guild_id)) => match app.music.add(&channel_id, &guild_id, &user, &url).await {
                    Ok(v) => v,
                    Err(e) => json!({ "error": e }),
                },
            };
            if let Some(id) = id {
                let _ = tx.send(json!({ "re": id, "d": reply }).to_string());
            }
        });
    }

    /// Editar/excluir mensagem de conversa direta (só o autor).
    async fn edit_dm_message(&self, app: &Arc<App>, user: &User, op: &str, message_id: &str, content: &str) -> Option<Value> {
        let err = |m: &str| Some(json!({ "error": m }));
        let row = app
            .db
            .query_one(
                "SELECT m.author_id, d.id, d.user_a, d.user_b, m.content FROM dm_messages m JOIN dm_channels d ON d.id = m.dm_id \
                 WHERE m.id = ?1 AND (d.user_a = ?2 OR d.user_b = ?2)",
                [message_id, user.id.as_str()],
                |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, [r.get::<String>(2)?, r.get::<String>(3)?], r.get::<String>(4)?)),
            )
            .await
            .ok()
            .flatten();
        let Some((author, dm_id, users, sealed)) = row else { return err("Mensagem não encontrada") };
        if author != user.id {
            return err("Sem permissão");
        }
        if op == "message:edit" {
            let content = content.trim();
            if content.is_empty() || content.chars().count() > 4000 {
                return err("Conteúdo inválido");
            }
            let edited_at = crate::now_ms();
            let sealed = app.db.cipher.seal(content);
            if app.db.execute("UPDATE dm_messages SET content = ?1, edited_at = ?2 WHERE id = ?3", libsql::params![sealed, edited_at, message_id]).await.is_err() {
                return err("Erro ao editar");
            }
            self.to_users(&users, "message:updated", json!({ "id": message_id, "channelId": dm_id, "content": content, "editedAt": edited_at }));
        } else {
            if app.db.execute("DELETE FROM dm_messages WHERE id = ?1", [message_id]).await.is_err() {
                return err("Erro ao excluir");
            }
            let _ = app.db.execute("DELETE FROM message_reactions WHERE message_id = ?1", [message_id]).await;
            crate::files::delete_message_file(app, &sealed, &dm_id).await;
            self.to_users(&users, "message:deleted", json!({ "id": message_id, "channelId": dm_id }));
        }
        Some(json!({ "ok": true }))
    }

    /// Processa uma operação; devolve `Some(resposta)` quando há algo a responder.
    async fn handle(&self, app: &Arc<App>, conn_id: &str, user: &User, op: &str, d: Value) -> Option<Value> {
        // Nome/foto podem ter mudado depois que a conexão abriu: operações que exibem o autor usam o atual.
        let fresh;
        let user = if matches!(op, "message:send" | "voice:join") {
            let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
            fresh = app.db.query_one(&sql, [user.id.as_str()], user_from_row).await.ok().flatten();
            fresh.as_ref().unwrap_or(user)
        } else {
            user
        };
        let str_field = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let err = |m: &str| Some(json!({ "error": m }));

        match op {
            "message:send" => {
                let content = str_field("content").trim().to_string();
                if content.is_empty() || content.chars().count() > 4000 {
                    return err("Mensagem vazia ou longa demais");
                }
                let channel_id = str_field("channelId");
                let mut msg = Message {
                    id: uuid::Uuid::new_v4().to_string(),
                    channel_id: channel_id.clone(),
                    content,
                    created_at: crate::now_ms(),
                    edited_at: None,
                    author: user.clone(),
                    reply_to: None,
                    reply: None,
                    reactions: Vec::new(),
                    expires_at: None,
                };
                let reply_to = str_field("replyTo");
                let ch = channel_with_access(app, &channel_id, &user.id).await;
                let Some(ch) = ch.filter(|c| c.kind == "text") else {
                    // Não é canal de servidor: talvez seja uma conversa direta.
                    let Some(dm) = crate::social::dm_with_access(app, &channel_id, &user.id).await else {
                        return err("Sem acesso ao canal");
                    };
                    msg.channel_id = dm.id.clone();
                    if !reply_to.is_empty() {
                        msg.reply = reply_ref(app, "dm_messages", "dm_id", &reply_to, &dm.id).await;
                        msg.reply_to = msg.reply.as_ref().map(|r| r.id.clone());
                    }
                    let preview = reply_preview(&msg.content);
                    app.push_to(
                        dm.other(&user.id),
                        crate::push::Note {
                            title: plain_text(&user.display_name),
                            body: preview,
                            tag: format!("dm:{}", dm.id),
                            url: format!("/?dm={}", dm.id),
                        },
                    );
                    let res = app
                        .db
                        .execute(
                            "INSERT INTO dm_messages (id, dm_id, author_id, content, created_at, reply_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            libsql::params![msg.id.as_str(), dm.id.as_str(), user.id.as_str(), app.db.cipher.seal(&msg.content), msg.created_at, msg.reply_to.clone()],
                        )
                        .await;
                    if let Err(e) = res {
                        app.logs.error(format!("message:send (DM): {e}"));
                        return err("Erro ao salvar mensagem");
                    }
                    msg.expires_at = crate::files::link_message(app, &msg.content, &dm.id, &user.id, &msg.id).await;
                    let _ = app
                        .db
                        .execute("UPDATE dm_channels SET last_message_at = ?1 WHERE id = ?2", libsql::params![msg.created_at, dm.id.as_str()])
                        .await;
                    self.to_users(&dm.users(), "message:new", &msg);
                    return Some(json!({ "message": msg }));
                };
                if !reply_to.is_empty() {
                    msg.reply = reply_ref(app, "messages", "channel_id", &reply_to, &ch.id).await;
                    msg.reply_to = msg.reply.as_ref().map(|r| r.id.clone());
                }
                let res = app
                    .db
                    .execute(
                        "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        libsql::params![msg.id.as_str(), msg.channel_id.as_str(), user.id.as_str(), app.db.cipher.seal(&msg.content), msg.created_at, msg.reply_to.clone()],
                    )
                    .await;
                if let Err(e) = res {
                    app.logs.error(format!("message:send: {e}"));
                    return err("Erro ao salvar mensagem");
                }
                msg.expires_at = crate::files::link_message(app, &msg.content, &ch.id, &user.id, &msg.id).await;
                self.to_channel(&ch.guild_id, &ch.id, "message:new", &msg);
                app.audit(
                    crate::audit::Entry::new(&ch.guild_id, "message.send", &user.id)
                        .channel(&ch.id)
                        .detail(json!({ "id": msg.id, "text": reply_preview(&msg.content) })),
                );
                // Push para quem pediu aviso das mensagens deste canal (ou foi citado com @).
                if app.push.is_some() {
                    let (app, ch, author, content) = (app.clone(), ch.clone(), user.clone(), msg.content.clone());
                    tokio::spawn(async move {
                        let said = crate::api::mentions(&plain_text(&content));
                        let body = format!("{}: {}", plain_text(&author.display_name), reply_preview(&content));
                        notify_guild(&app, &ch.guild_id, &author.id, Some(&ch.id), &body, &format!("ch:{}", ch.id), &format!("/?channel={}", ch.id), |name, n| {
                            n.wants_message(&ch.id, said.contains(&name.to_ascii_lowercase()))
                        })
                        .await;
                    });
                }
                Some(json!({ "message": msg }))
            }

            "message:edit" | "message:delete" => {
                let message_id = str_field("messageId");
                let row = app
                    .db
                    .query_one(
                        "SELECT m.author_id, c.guild_id, g.owner_id, m.channel_id, m.content FROM messages m \
                         JOIN channels c ON c.id = m.channel_id JOIN guilds g ON g.id = c.guild_id WHERE m.id = ?1",
                        [message_id.as_str()],
                        |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<String>(2)?, r.get::<String>(3)?, r.get::<String>(4)?)),
                    )
                    .await
                    .ok()
                    .flatten();
                let Some((author, guild_id, owner, channel_id, sealed)) = row else {
                    return self.edit_dm_message(app, user, op, &message_id, &str_field("content")).await;
                };
                let is_author = author == user.id;

                if op == "message:edit" {
                    let content = str_field("content").trim().to_string();
                    if !is_author {
                        return err("Sem permissão");
                    }
                    if content.is_empty() || content.chars().count() > 4000 {
                        return err("Conteúdo inválido");
                    }
                    let edited_at = crate::now_ms();
                    if app
                        .db
                        .execute("UPDATE messages SET content = ?1, edited_at = ?2 WHERE id = ?3", libsql::params![app.db.cipher.seal(&content), edited_at, message_id.as_str()])
                        .await
                        .is_err()
                    {
                        return err("Erro ao editar");
                    }
                    self.to_channel(&guild_id, &channel_id, "message:updated", json!({ "id": message_id, "channelId": channel_id, "content": content, "editedAt": edited_at }));
                    app.audit(
                        crate::audit::Entry::new(&guild_id, "message.edit", &user.id)
                            .channel(&channel_id)
                            .detail(json!({ "id": message_id, "before": reply_preview(&app.db.cipher.reveal(&sealed)), "text": reply_preview(&content) })),
                    );
                } else {
                    let admin = owner == user.id
                        || crate::api::member_perms(app, &guild_id, &user.id)
                            .await
                            .ok()
                            .flatten()
                            .is_some_and(|p| crate::api::perm::has(p, crate::api::perm::ADMIN));
                    if !is_author && !admin {
                        return err("Sem permissão");
                    }
                    if app.db.execute("DELETE FROM messages WHERE id = ?1", [message_id.as_str()]).await.is_err() {
                        return err("Erro ao excluir");
                    }
                    let _ = app.db.execute("DELETE FROM message_reactions WHERE message_id = ?1", [message_id.as_str()]).await;
                    crate::files::delete_message_file(app, &sealed, &channel_id).await;
                    self.to_channel(&guild_id, &channel_id, "message:deleted", json!({ "id": message_id, "channelId": channel_id }));
                    let mut entry = crate::audit::Entry::new(&guild_id, "message.delete", &user.id)
                        .channel(&channel_id)
                        .detail(json!({ "id": message_id, "text": reply_preview(&app.db.cipher.reveal(&sealed)) }));
                    if !is_author {
                        entry = entry.target(&author);
                    }
                    app.audit(entry);
                }
                Some(json!({ "ok": true }))
            }

            // Reagir (ou tirar a reação) com um emoticon.
            "message:react" => {
                let message_id = str_field("messageId");
                let emoji = str_field("emoji").trim().to_string();
                let on = d.get("on").and_then(Value::as_bool).unwrap_or(true);
                if emoji.is_empty() || emoji.chars().count() > 32 || emoji.contains('\n') {
                    return err("Emoticon inválido");
                }
                // Onde está a mensagem: canal de servidor ou conversa direta (e se eu tenho acesso).
                let guild_place = app
                    .db
                    .query_one("SELECT channel_id FROM messages WHERE id = ?1", [message_id.as_str()], |r| r.get::<String>(0))
                    .await
                    .ok()
                    .flatten();
                let (channel_id, audience) = match guild_place {
                    Some(ch_id) => match channel_with_access(app, &ch_id, &user.id).await {
                        Some(ch) => (ch.id, Err(ch.guild_id)),
                        None => return err("Sem acesso ao canal"),
                    },
                    None => {
                        let dm_id = app
                            .db
                            .query_one("SELECT dm_id FROM dm_messages WHERE id = ?1", [message_id.as_str()], |r| r.get::<String>(0))
                            .await
                            .ok()
                            .flatten();
                        match dm_id {
                            Some(id) => match crate::social::dm_with_access(app, &id, &user.id).await {
                                Some(dm) => (dm.id.clone(), Ok(dm.users())),
                                None => return err("Mensagem não encontrada"),
                            },
                            None => return err("Mensagem não encontrada"),
                        }
                    }
                };
                if on {
                    let kinds = app
                        .db
                        .query_one("SELECT COUNT(DISTINCT emoji) FROM message_reactions WHERE message_id = ?1", [message_id.as_str()], |r| {
                            r.get::<i64>(0)
                        })
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or(0);
                    if kinds >= 20 {
                        return err("Esta mensagem já tem reações demais");
                    }
                    let _ = app
                        .db
                        .execute(
                            "INSERT OR IGNORE INTO message_reactions (message_id, channel_id, user_id, emoji, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                            libsql::params![message_id.as_str(), channel_id.as_str(), user.id.as_str(), emoji.as_str(), crate::now_ms()],
                        )
                        .await;
                } else {
                    let _ = app
                        .db
                        .execute(
                            "DELETE FROM message_reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3",
                            [message_id.as_str(), user.id.as_str(), emoji.as_str()],
                        )
                        .await;
                }
                let rows = app
                    .db
                    .query_all(
                        "SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id = ?1 ORDER BY created_at",
                        [message_id.as_str()],
                        |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<String>(2)?)),
                    )
                    .await
                    .unwrap_or_default();
                let reactions: Vec<Reaction> = group_reactions(rows).remove(&message_id).unwrap_or_default();
                let payload = json!({ "channelId": channel_id, "messageId": message_id, "reactions": reactions });
                match audience {
                    Err(guild_id) => self.to_channel(&guild_id, &channel_id, "message:reactions", payload),
                    Ok(users) => self.to_users(&users, "message:reactions", payload),
                }
                Some(json!({ "ok": true }))
            }

            "typing" => {
                let channel_id = str_field("channelId");
                if let Some(ch) = channel_with_access(app, &channel_id, &user.id).await {
                    let s = self.state.lock().unwrap();
                    let msg = event("typing", json!({ "channelId": ch.id, "user": user }));
                    Self::send_to_channel(&s, &ch.guild_id, &ch.id, &msg, Some(conn_id));
                } else if let Some(dm) = crate::social::dm_with_access(app, &channel_id, &user.id).await {
                    self.to_user(dm.other(&user.id), "typing", json!({ "channelId": dm.id, "user": user }));
                }
                None
            }

            "ping" => Some(json!({ "t": crate::now_ms() })),

            "status:set" => {
                let status = str_field("status");
                if !STATUSES.contains(&status.as_str()) {
                    return err("Status inválido");
                }
                if app.db.execute("UPDATE users SET status = ?1 WHERE id = ?2", [status.as_str(), user.id.as_str()]).await.is_err() {
                    return err("Erro ao salvar o status");
                }
                self.set_status(&user.id, &status);
                Some(json!({ "status": status }))
            }

            // O app do Windows conta o jogo em foco: { activity: { type: "playing", name } | null }.
            "activity:set" => {
                let activity = match d.get("activity") {
                    Some(Value::Object(a)) => {
                        let name: String = a
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .chars()
                            .filter(|c| !c.is_control())
                            .collect::<String>()
                            .trim()
                            .chars()
                            .take(80)
                            .collect();
                        if name.is_empty() {
                            return err("Atividade inválida");
                        }
                        let started = a.get("since").and_then(Value::as_i64).filter(|t| *t > 0 && *t <= crate::now_ms());
                        Some(json!({ "type": "playing", "name": name, "since": started.unwrap_or_else(crate::now_ms) }))
                    }
                    _ => None,
                };
                self.set_activity(&user.id, conn_id, activity);
                Some(json!({ "ok": true }))
            }

            "nudge:send" => {
                let channel_id = str_field("channelId");
                let (target_id, recipients, dm) = match channel_with_access(app, &channel_id, &user.id).await {
                    Some(ch) if ch.kind == "text" => (ch.id.clone(), self.online_in_guild(&ch.guild_id, &user.id), false),
                    _ => match crate::social::dm_with_access(app, &channel_id, &user.id).await {
                        Some(dm) => (dm.id.clone(), vec![dm.other(&user.id).to_string()], true),
                        None => return err("Sem acesso ao canal"),
                    },
                };
                if let Err(wait) = self.take_nudge(&user.id) {
                    return err(&format!(
                        "Você só pode chamar a atenção {NUDGES_PER_MINUTE} vezes por minuto. Tente de novo em {wait} s."
                    ));
                }
                let mut delivered = Vec::new();
                let mut refused = 0;
                for r in recipients {
                    if crate::social::accepts_nudge(app, &r, &user.id).await {
                        delivered.push(r);
                    } else {
                        refused += 1;
                    }
                }
                self.to_users(&delivered, "nudge", json!({ "channelId": target_id, "dm": dm, "from": user, "at": crate::now_ms() }));
                for r in &delivered {
                    app.push_to(
                        r,
                        crate::push::Note {
                            title: "PadoSpeak".into(),
                            body: format!("{} chamou a sua atenção!", plain_text(&user.display_name)),
                            tag: format!("nudge:{target_id}"),
                            url: if dm { format!("/?dm={target_id}") } else { "/".into() },
                        },
                    );
                }
                Some(json!({ "delivered": delivered.len(), "refused": refused, "channelId": target_id }))
            }

            "call:decline" => {
                if let Some(dm) = crate::social::dm_with_access(app, &str_field("dmId"), &user.id).await {
                    self.to_user(dm.other(&user.id), "call:declined", json!({ "dmId": dm.id, "by": user }));
                }
                None
            }

            "voice:join" => {
                let channel_id = str_field("channelId");
                let (ch_id, guild_id, dm_users) = match channel_with_access(app, &channel_id, &user.id).await {
                    Some(ch) if ch.kind == "voice" => (ch.id, ch.guild_id, None),
                    _ => match crate::social::dm_with_access(app, &channel_id, &user.id).await {
                        Some(dm) => (dm.id.clone(), String::new(), Some(dm.users())),
                        None => return err("Canal de voz não encontrado"),
                    },
                };
                let mut s = self.state.lock().unwrap();
                Self::leave_voice_locked(&mut s, conn_id);
                let me = Participant {
                    peer_id: conn_id.to_string(),
                    user: user.clone(),
                    guild_id: guild_id.clone(),
                    dm_users: dm_users.clone(),
                    muted: d.get("muted").and_then(Value::as_bool).unwrap_or(false),
                    deafened: d.get("deafened").and_then(Value::as_bool).unwrap_or(false),
                    video: false,
                    screen: false,
                    camera_stream_id: None,
                    screen_stream_id: None,
                    server_muted: false,
                    joined_at: crate::now_ms(),
                };
                if dm_users.is_none() {
                    app.audit(crate::audit::Entry::new(&guild_id, "voice.join", &user.id).channel(&ch_id));
                }
                let list = s.voice.entry(ch_id.clone()).or_default();
                let peers = list.clone();
                list.push(me.clone());
                s.conn_voice.insert(conn_id.to_string(), ch_id.clone());
                let joined = event("voice:peer-joined", &me);
                for p in &peers {
                    Self::send_to(&s, &p.peer_id, joined.clone());
                }
                Self::broadcast_voice_channel(&s, &me, &ch_id);
                // Chamada 1 a 1: toca para o outro lado se ele ainda não estiver na chamada.
                let mut ringing = None;
                if let Some(users) = &dm_users {
                    let other = users.iter().find(|u| **u != user.id).cloned().unwrap_or_default();
                    if !peers.iter().any(|p| p.user.id == other) {
                        Self::send_to_user(&s, &other, &event("call:ring", json!({ "dmId": ch_id, "from": user })));
                        ringing = Some(other);
                    }
                }
                drop(s);
                if dm_users.is_none() && app.push.is_some() {
                    let (app, user, ch_id, guild_id) = (app.clone(), user.clone(), ch_id.clone(), guild_id.clone());
                    tokio::spawn(async move {
                        let name = channel_name(&app, &ch_id).await;
                        let body = format!("{} entrou em 🔊 {name}", plain_text(&user.display_name));
                        notify_guild(&app, &guild_id, &user.id, Some(&ch_id), &body, &format!("voice:{ch_id}"), "/", |_, n| n.voice_join).await;
                    });
                }
                if let Some(other) = ringing {
                    app.push_to(
                        &other,
                        crate::push::Note {
                            title: plain_text(&user.display_name),
                            body: "está chamando você".into(),
                            tag: format!("call:{ch_id}"),
                            url: format!("/?dm={ch_id}"),
                        },
                    );
                }
                Some(json!({ "ok": true, "channelId": ch_id, "guildId": guild_id, "dm": dm_users.is_some(), "peers": peers }))
            }

            "voice:leave" => {
                let mut s = self.state.lock().unwrap();
                Self::leave_voice_locked(&mut s, conn_id);
                Some(json!({ "ok": true }))
            }

            "voice:state" => {
                let mut s = self.state.lock().unwrap();
                let Some(channel_id) = s.conn_voice.get(conn_id).cloned() else { return None };
                let Some(me) = s.voice.get_mut(&channel_id).and_then(|l| l.iter_mut().find(|p| p.peer_id == conn_id)) else {
                    return None;
                };
                let flag = |k: &str, cur: bool| d.get(k).and_then(Value::as_bool).unwrap_or(cur);
                let started_stream = !me.screen && flag("screen", me.screen) && me.dm_users.is_none();
                me.muted = flag("muted", me.muted);
                me.deafened = flag("deafened", me.deafened);
                me.video = flag("video", me.video);
                me.screen = flag("screen", me.screen);
                for (k, slot) in [("cameraStreamId", &mut me.camera_stream_id), ("screenStreamId", &mut me.screen_stream_id)] {
                    if let Some(v) = d.get(k) {
                        *slot = v.as_str().map(|s| s.chars().take(100).collect());
                    }
                }
                let me = me.clone();
                let msg = event("voice:peer-state", &me);
                for p in s.voice.get(&channel_id).into_iter().flatten().filter(|p| p.peer_id != conn_id) {
                    Self::send_to(&s, &p.peer_id, msg.clone());
                }
                Self::broadcast_voice_channel(&s, &me, &channel_id);
                drop(s);
                if started_stream && app.push.is_some() {
                    let (app, me) = (app.clone(), me.clone());
                    tokio::spawn(async move {
                        let name = channel_name(&app, &channel_id).await;
                        let body = format!("{} começou a transmitir em 🔊 {name}", plain_text(&me.user.display_name));
                        notify_guild(&app, &me.guild_id, &me.user.id, Some(&channel_id), &body, &format!("stream:{channel_id}"), "/", |_, n| n.streams).await;
                    });
                }
                None
            }

            // Favoritas (de cada pessoa) e "Mais tocadas" (do servidor, últimas 2 semanas).
            "music:library" => {
                let guild_id = str_field("guildId");
                let top = if guild_id.is_empty() || !crate::api::is_member(app, &guild_id, &user.id).await.unwrap_or(false) {
                    Vec::new()
                } else {
                    crate::music::library::top(&app.db, &guild_id).await.unwrap_or_default()
                };
                let favorites = crate::music::library::favorites(&app.db, &user.id).await.unwrap_or_default();
                Some(json!({ "favorites": favorites, "top": top }))
            }
            "music:favorite" => {
                let on = d.get("on").and_then(Value::as_bool).unwrap_or(true);
                let track = d.get("track").cloned().unwrap_or(Value::Null);
                Some(match crate::music::library::set_favorite(&app.db, &user.id, &track, on).await {
                    Ok(()) => json!({ "favorites": crate::music::library::favorites(&app.db, &user.id).await.unwrap_or_default() }),
                    Err(e) => json!({ "error": e }),
                })
            }

            "music:pause" | "music:resume" | "music:skip" | "music:previous" | "music:restart" | "music:remove" | "music:clear" => {
                let Some((channel_id, _)) = self.voice_channel_of(conn_id) else {
                    return err("Entre no canal de voz para controlar a música");
                };
                let track_id = d.get("trackId").and_then(Value::as_str);
                Some(match app.music.control(&channel_id, op, track_id) {
                    Ok(()) => json!({ "ok": true }),
                    Err(e) => json!({ "error": e }),
                })
            }

            // Repassa oferta/resposta/ICE somente entre conexões do mesmo canal de voz.
            "voice:signal" => {
                let to = str_field("to");
                let s = self.state.lock().unwrap();
                let mine = s.conn_voice.get(conn_id);
                if mine.is_some() && mine == s.conn_voice.get(&to) {
                    let data = d.get("data").cloned().unwrap_or(Value::Null);
                    Self::send_to(&s, &to, event("voice:signal", json!({ "from": conn_id, "data": data })));
                }
                None
            }

            // Até onde recebi (`delivered`) e li (`read`) uma conversa/canal: os "vistos".
            "read:mark" => {
                let channel_id = str_field("channelId");
                let now = crate::now_ms();
                let read = d.get("read").and_then(Value::as_i64).unwrap_or(0).clamp(0, now);
                let delivered = d.get("delivered").and_then(Value::as_i64).unwrap_or(0).clamp(0, now).max(read);
                if delivered == 0 {
                    return None;
                }
                let audience = match channel_with_access(app, &channel_id, &user.id).await {
                    Some(ch) if ch.kind == "text" => Err((ch.guild_id, ch.id)),
                    _ => match crate::social::dm_with_access(app, &channel_id, &user.id).await {
                        Some(dm) => Ok((dm.id.clone(), dm.users())),
                        None => return None,
                    },
                };
                let place = match &audience {
                    Err((_, ch)) => ch.clone(),
                    Ok((dm, _)) => dm.clone(),
                };
                let _ = app
                    .db
                    .execute(
                        "INSERT INTO read_marks (channel_id, user_id, delivered_at, read_at) VALUES (?1, ?2, ?3, ?4) \
                         ON CONFLICT(channel_id, user_id) DO UPDATE SET delivered_at = MAX(delivered_at, excluded.delivered_at), \
                         read_at = MAX(read_at, excluded.read_at)",
                        libsql::params![place.as_str(), user.id.as_str(), delivered, read],
                    )
                    .await;
                let Some((d_at, r_at)) = app
                    .db
                    .query_one("SELECT delivered_at, read_at FROM read_marks WHERE channel_id = ?1 AND user_id = ?2", [place.as_str(), user.id.as_str()], |r| {
                        Ok((r.get::<i64>(0)?, r.get::<i64>(1)?))
                    })
                    .await
                    .ok()
                    .flatten()
                else {
                    return None;
                };
                let payload = json!({ "channelId": place, "userId": user.id, "deliveredAt": d_at, "readAt": r_at });
                match audience {
                    Err((guild, ch)) => self.to_channel(&guild, &ch, "read:mark", payload),
                    Ok((_, users)) => self.to_users(&users, "read:mark", payload),
                }
                None
            }

            // Moderação de voz: silenciar para todos, desconectar ou mover alguém de canal.
            "voice:moderate" => {
                let target_peer = str_field("peerId");
                let action = str_field("action");
                let found = {
                    let s = self.state.lock().unwrap();
                    s.conn_voice.get(&target_peer).cloned().and_then(|ch| {
                        let p = s.voice.get(&ch)?.iter().find(|p| p.peer_id == target_peer)?.clone();
                        Some((ch, p))
                    })
                };
                let Some((channel_id, target)) = found else { return err("A pessoa não está mais no canal de voz") };
                if target.dm_users.is_some() {
                    return err("Isso só vale nos canais de voz dos servidores");
                }
                let guild_id = target.guild_id.clone();
                use crate::api::perm;
                let flag = match action.as_str() {
                    "mute" | "unmute" => perm::MUTE,
                    "disconnect" => perm::DISCONNECT,
                    "move" => perm::MOVE,
                    _ => return err("Ação inválida"),
                };
                let mine = crate::api::member_perms(app, &guild_id, &user.id).await.ok().flatten().unwrap_or(0);
                if !perm::has(mine, flag) {
                    return err("Você não tem permissão para isso");
                }
                let (owner, move_sound) = app
                    .db
                    .query_one("SELECT owner_id, move_sound FROM guilds WHERE id = ?1", [guild_id.as_str()], |r| {
                        Ok((r.get::<String>(0)?, r.get::<i64>(1)? != 0))
                    })
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if target.user.id == owner && user.id != owner {
                    return err("Ninguém pode fazer isso com o dono do servidor");
                }
                let by = json!({ "id": user.id, "displayName": user.display_name, "username": user.username });
                match action.as_str() {
                    "mute" | "unmute" => {
                        let on = action == "mute";
                        let mut s = self.state.lock().unwrap();
                        let Some(p) = s.voice.get_mut(&channel_id).and_then(|l| l.iter_mut().find(|p| p.peer_id == target_peer)) else {
                            return err("A pessoa não está mais no canal de voz");
                        };
                        p.server_muted = on;
                        let p = p.clone();
                        let msg = event("voice:peer-state", &p);
                        for other in s.voice.get(&channel_id).into_iter().flatten().filter(|o| o.peer_id != target_peer) {
                            Self::send_to(&s, &other.peer_id, msg.clone());
                        }
                        Self::send_to(&s, &target_peer, event("voice:server-mute", json!({ "muted": on, "by": by })));
                        Self::broadcast_voice_channel(&s, &p, &channel_id);
                        drop(s);
                        app.audit(
                            crate::audit::Entry::new(&guild_id, if on { "voice.mute" } else { "voice.unmute" }, &user.id)
                                .target(&target.user.id)
                                .channel(&channel_id),
                        );
                    }
                    "disconnect" => {
                        let mut s = self.state.lock().unwrap();
                        Self::send_to(&s, &target_peer, event("voice:moderated", json!({ "action": "disconnect", "by": by })));
                        Self::kick_from_voice(&mut s, &target_peer);
                        drop(s);
                        app.audit(crate::audit::Entry::new(&guild_id, "voice.disconnect", &user.id).target(&target.user.id).channel(&channel_id));
                    }
                    _ => {
                        let to = str_field("channelId");
                        let dest = channel_with_access(app, &to, &target.user.id).await.filter(|c| c.kind == "voice" && c.guild_id == guild_id);
                        let Some(dest) = dest else { return err("Essa pessoa não pode entrar nesse canal de voz") };
                        if dest.id == channel_id {
                            return Some(json!({ "ok": true }));
                        }
                        let mut s = self.state.lock().unwrap();
                        Self::leave_voice_locked(&mut s, &target_peer);
                        Self::send_to(&s, &target_peer, event("voice:move", json!({ "channelId": dest.id, "by": by })));
                        let moved = event(
                            "voice:moved",
                            json!({ "guildId": guild_id, "user": target.user, "from": channel_id, "to": dest.id, "by": by, "sound": move_sound }),
                        );
                        Self::send_to_guild(&s, &guild_id, &moved, None);
                        drop(s);
                        app.audit(
                            crate::audit::Entry::new(&guild_id, "voice.move", &user.id)
                                .target(&target.user.id)
                                .channel(&dest.id)
                                .detail(json!({ "from": channel_id })),
                        );
                    }
                }
                Some(json!({ "ok": true }))
            }

            // Aparecer (ou não) para quem está na mesma rede; `device`: celular, computador…
            "lan:hello" => {
                let visible = d.get("visible").and_then(Value::as_bool).unwrap_or(false);
                let device: String = str_field("device").chars().take(24).collect();
                let mut s = self.state.lock().unwrap();
                let net = match s.conns.get_mut(conn_id) {
                    Some(c) => {
                        let changed = c.nearby != visible || c.device != device;
                        c.nearby = visible;
                        c.device = device;
                        changed.then(|| c.net.key.clone())
                    }
                    None => None,
                };
                match net {
                    Some(net) => Self::send_nearby(&s, &net),
                    // Nada mudou: só reenvia a lista para quem pediu.
                    None => {
                        if let Some(net) = s.conns.get(conn_id).filter(|c| c.nearby).map(|c| c.net.key.clone()) {
                            Self::send_nearby(&s, &net);
                        }
                    }
                }
                Some(json!({ "ok": true }))
            }

            // Sinalização da conexão de teste entre dois aparelhos da mesma rede (confirma que estão
            // mesmo na mesma rede local, e não só atrás do mesmo IP público).
            "lan:signal" => {
                let to = str_field("to");
                let s = self.state.lock().unwrap();
                let same = match (s.conns.get(conn_id), s.conns.get(&to)) {
                    (Some(a), Some(b)) => a.nearby && b.nearby && !a.net.key.is_empty() && a.net.key == b.net.key,
                    _ => false,
                };
                if same {
                    let data = d.get("data").cloned().unwrap_or(Value::Null);
                    Self::send_to(&s, &to, event("lan:signal", json!({ "from": conn_id, "data": data })));
                }
                None
            }

            // O app abriu: plataforma (app, pwa, navegador), aparelho e sistema, para o painel do administrador.
            "app:hello" => {
                let clean = |k: &str| -> String { str_field(k).chars().filter(|c| c.is_alphanumeric() || " .-".contains(*c)).take(24).collect() };
                let platform = match str_field("platform").as_str() {
                    p @ ("app" | "pwa" | "navegador") => p.to_string(),
                    _ => "navegador".into(),
                };
                let started = self.state.lock().unwrap().conns.get(conn_id).is_some_and(|c| c.session.is_some());
                if !started {
                    if let Some(id) = crate::admin::start_session(app, &user.id, &platform, &clean("device"), &clean("os")).await {
                        if let Some(c) = self.state.lock().unwrap().conns.get_mut(conn_id) {
                            c.session = Some(id);
                        }
                    }
                }
                None
            }

            // O app foi para segundo plano (ou voltou): decide se as notificações vão por push.
            "app:visibility" => {
                let visible = d.get("visible").and_then(Value::as_bool).unwrap_or(true);
                if let Some(c) = self.state.lock().unwrap().conns.get_mut(conn_id) {
                    c.visible = visible;
                }
                None
            }

            _ => err("Operação desconhecida"),
        }
    }
}

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    d: Value,
    id: Option<u64>,
}

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let Some(user) = crate::auth::user_from_token(&app.db, &q.token).await else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    let hub = app.hub.clone();
    let net = Net::from_ip(client_ip(addr, &headers));
    ws.max_message_size(256 * 1024).on_upgrade(move |socket| hub.run(app, socket, user, net))
}

/// Nome de um canal (para os avisos).
async fn channel_name(app: &App, channel_id: &str) -> String {
    app.db
        .query_one("SELECT name FROM channels WHERE id = ?1", [channel_id], |r| r.get::<String>(0))
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Push para os membros do servidor que querem saber disto (`wants(usuário, configuração)`), que
/// veem o canal (se houver) e não estão com o app aberto na tela.
#[allow(clippy::too_many_arguments)]
pub async fn notify_guild(
    app: &Arc<App>,
    guild_id: &str,
    except: &str,
    channel_id: Option<&str>,
    body: &str,
    tag: &str,
    url: &str,
    wants: impl Fn(&str, &crate::api::NotifySettings) -> bool,
) {
    let title = app
        .db
        .query_one("SELECT name FROM guilds WHERE id = ?1", [guild_id], |r| r.get::<String>(0))
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "PadoSpeak".into());
    for (user_id, username, settings) in crate::api::notify_audience(app, guild_id, except).await {
        if channel_id.is_some_and(|c| !app.hub.user_can_see(c, &user_id)) || !wants(&username, &settings) {
            continue;
        }
        app.push_to(&user_id, crate::push::Note { title: title.clone(), body: body.to_string(), tag: tag.to_string(), url: url.to_string() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chamar_atencao_no_maximo_3_por_minuto() {
        let (hub, _rx) = Hub::new();
        for _ in 0..NUDGES_PER_MINUTE {
            assert!(hub.take_nudge("ana").is_ok());
        }
        let espera = hub.take_nudge("ana").unwrap_err();
        assert!((1..=60).contains(&espera), "espera de {espera} s");
        // O limite é por pessoa.
        assert!(hub.take_nudge("bia").is_ok());
    }

    #[test]
    fn rede_de_quem_conecta() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        // Atrás do nginx (127.0.0.1 / rede do Docker): vale o X-Real-IP.
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", "200.10.20.30".parse().unwrap());
        assert_eq!(client_ip("172.18.0.5:5000".parse().unwrap(), &h), ip("200.10.20.30"));
        // Conexão direta da internet: o cabeçalho não vale (qualquer um poderia mandar).
        assert_eq!(client_ip("8.8.8.8:5000".parse().unwrap(), &h), ip("8.8.8.8"));
        let casa = Net::from_ip(ip("200.10.20.30"));
        assert!(!casa.direct, "IPv4 público precisa de confirmação");
        let a = Net::from_ip(ip("2804:14d:1:2:aaaa::1"));
        let b = Net::from_ip(ip("2804:14d:1:2:bbbb::9"));
        assert_eq!(a, b);
        assert!(a.direct);
        assert_ne!(a, Net::from_ip(ip("2804:14d:1:3::1")));
        assert_eq!(Net::from_ip(ip("192.168.0.10")), Net::from_ip(ip("192.168.0.77")));
    }

    #[test]
    fn invisivel_nao_aparece_online() {
        let (hub, _rx) = Hub::new();
        {
            let mut s = hub.state.lock().unwrap();
            s.user_conns.entry("ana".into()).or_default().insert("c1".into());
        }
        assert!(hub.is_online("ana"));
        hub.set_status("ana", "invisible");
        assert!(!hub.is_online("ana"));
        assert_eq!(hub.presence_of("ana"), None);
        hub.set_status("ana", "busy");
        assert_eq!(hub.presence_of("ana").as_deref(), Some("busy"));
    }

    #[test]
    fn atividade_vai_para_os_amigos() {
        let (hub, _rx) = Hub::new();
        let (tx, mut bia) = unbounded_channel();
        let conn = |user: &str, tx: UnboundedSender<String>, friend: &str| Conn {
            tx,
            user_id: user.into(),
            guilds: HashSet::new(),
            friends: [friend.to_string()].into(),
            visible: true,
            net: Net::from_ip("10.0.0.1".parse().unwrap()),
            nearby: false,
            device: String::new(),
            session: None,
        };
        {
            let mut s = hub.state.lock().unwrap();
            s.user_conns.entry("ana".into()).or_default().insert("c1".into());
            s.user_conns.entry("bia".into()).or_default().insert("c2".into());
            s.conns.insert("c1".into(), conn("ana", unbounded_channel().0, "bia"));
            s.conns.insert("c2".into(), conn("bia", tx, "ana"));
        }
        let cs = json!({ "type": "playing", "name": "Counter-Strike 2", "since": 1 });
        hub.set_activity("ana", "c1", Some(cs.clone()));
        let msg: Value = serde_json::from_str(&bia.try_recv().unwrap()).unwrap();
        assert_eq!(msg["d"]["activity"], cs);
        // A mesma atividade de novo não gera aviso.
        hub.set_activity("ana", "c1", Some(cs));
        assert!(bia.try_recv().is_err());
        // Invisível: some junto com a presença, e trocar a atividade não avisa ninguém.
        hub.set_status("ana", "invisible");
        let msg: Value = serde_json::from_str(&bia.try_recv().unwrap()).unwrap();
        assert_eq!(msg["d"]["online"], false);
        assert_eq!(msg["d"]["activity"], Value::Null);
        hub.set_activity("ana", "c1", None);
        assert!(bia.try_recv().is_err());
    }
}

/// A mensagem respondida, se ela estiver na mesma conversa/canal (o texto citado já decifrado).
async fn reply_ref(app: &App, table: &str, place_col: &str, id: &str, place: &str) -> Option<ReplyRef> {
    let sql = format!(
        "SELECT m.id, m.content, u.id, u.display_name FROM {table} m JOIN users u ON u.id = m.author_id \
         WHERE m.id = ?1 AND m.{place_col} = ?2"
    );
    let (rid, content, author_id, author_name) = app
        .db
        .query_one(&sql, [id, place], |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<String>(2)?, r.get::<String>(3)?)))
        .await
        .ok()
        .flatten()?;
    Some(ReplyRef { id: rid, author_id, author_name: plain_text(&author_name), preview: reply_preview(&app.db.cipher.reveal(&content)) })
}
