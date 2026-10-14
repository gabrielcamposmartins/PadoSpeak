//! Rede local (LAN): os PCs com PadoSpeak se anunciam por broadcast UDP e conversam P2P.
//!
//! Cada app desktop roda um **nó local** (este servidor em modo local) que guarda o perfil local e
//! só aceita login vindo do próprio PC. Os nós se anunciam a cada poucos segundos com os perfis
//! online, e os apps mostram esses perfis com a tag LAN.
//!
//! Conversa e chamada entre dois perfis da rede acontecem **no nó de quem tem o menor id**: o outro
//! entra lá como convidado (`origin = 'lan'`) por `POST /api/lan/session`. A primeira conexão fixa a
//! chave do PC dele (TOFU); as seguintes precisam apresentar a mesma chave, então outro PC da rede
//! não consegue se passar por ele. A mídia das chamadas vai direto entre os dois PCs (WebRTC).
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use crate::models::{fit_formatted, user_from_row, valid_color, visible_len, User, BIO_MAX, BIO_RAW_MAX, NAME_MAX, NAME_RAW_MAX, USER_COLS};
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Porta UDP dos anúncios (a mesma em todos os PCs).
pub const BEACON_PORT: u16 = 47822;
const ANNOUNCE_EVERY: Duration = Duration::from_secs(3);
/// Sem anúncio por este tempo, o PC sai da lista.
const EXPIRE_AFTER: Duration = Duration::from_secs(11);
const MAX_BEACON: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hosting {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BeaconUser {
    id: String,
    username: String,
    display_name: String,
    avatar_color: String,
    avatar_at: Option<i64>,
    #[serde(default)]
    bio: String,
    name_color: Option<String>,
    bio_color: Option<String>,
    #[serde(default)]
    banner_color: Option<String>,
    status: String,
}

#[derive(Serialize, Deserialize)]
struct Beacon {
    app: String,
    v: u32,
    node: String,
    port: u16,
    users: Vec<BeaconUser>,
    hosting: Option<Hosting>,
}

struct Peer {
    addr: IpAddr,
    port: u16,
    users: Vec<BeaconUser>,
    hosting: Option<Hosting>,
    seen: Instant,
}

/// Perfil de outro PC da rede, como o cliente recebe.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanPeer {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub avatar_url: Option<String>,
    pub bio: String,
    pub name_color: Option<String>,
    pub bio_color: Option<String>,
    pub banner_color: Option<String>,
    pub status: String,
    /// Endereço do nó local daquele PC (onde ficam as conversas em que ele é o "dono").
    pub node_url: String,
    pub node: String,
    /// Servidor que aquele PC está hospedando, se houver.
    pub hosting: Option<Hosting>,
}

pub struct Lan {
    pub node_id: String,
    port: u16,
    peers: Mutex<HashMap<String, Peer>>,
    hosting: Mutex<Option<Hosting>>,
}

/// Endereço da rede local (ou do próprio PC): só daí o nó aceita convidados.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(v4));
            }
            let seg = v6.segments()[0];
            v6.is_loopback() || (seg & 0xfe00) == 0xfc00 || (seg & 0xffc0) == 0xfe80
        }
    }
}

impl Lan {
    pub fn new(node_id: String, port: u16, hosting: Option<Hosting>) -> Arc<Self> {
        Arc::new(Self { node_id, port, peers: Mutex::new(HashMap::new()), hosting: Mutex::new(hosting) })
    }

    pub fn set_hosting(&self, hosting: Option<Hosting>) {
        *self.hosting.lock().unwrap() = hosting;
    }

    /// Perfis vistos na rede (um por usuário online em cada PC).
    pub fn peers(&self) -> Vec<LanPeer> {
        let peers = self.peers.lock().unwrap();
        let mut list: Vec<LanPeer> = peers
            .iter()
            .flat_map(|(node, p)| {
                let base = format!("http://{}:{}", url_host(p.addr), p.port);
                p.users.iter().map(move |u| LanPeer {
                    id: u.id.clone(),
                    username: u.username.clone(),
                    display_name: u.display_name.clone(),
                    avatar_color: u.avatar_color.clone(),
                    avatar_url: u.avatar_at.map(|v| format!("{base}/api/users/{}/avatar?v={v}", u.id)),
                    bio: u.bio.clone(),
                    name_color: u.name_color.clone(),
                    bio_color: u.bio_color.clone(),
                    banner_color: u.banner_color.clone(),
                    status: u.status.clone(),
                    node_url: base.clone(),
                    node: node.clone(),
                    hosting: p.hosting.clone(),
                })
            })
            .collect();
        list.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
        list
    }

    /// Registra um anúncio; devolve `true` se a lista mudou.
    fn see(&self, from: IpAddr, beacon: Beacon) -> bool {
        let mut peers = self.peers.lock().unwrap();
        let changed = match peers.get(&beacon.node) {
            Some(p) => p.users != beacon.users || p.hosting != beacon.hosting || p.addr != from || p.port != beacon.port,
            None => true,
        };
        peers.insert(
            beacon.node,
            Peer { addr: from, port: beacon.port, users: beacon.users, hosting: beacon.hosting, seen: Instant::now() },
        );
        changed
    }

    /// Tira da lista quem parou de anunciar; devolve `true` se alguém saiu.
    fn sweep(&self) -> bool {
        let mut peers = self.peers.lock().unwrap();
        let before = peers.len();
        peers.retain(|_, p| p.seen.elapsed() < EXPIRE_AFTER);
        peers.len() != before
    }

    /// Liga o anúncio e a escuta enquanto o nó estiver no ar.
    pub fn spawn(self: &Arc<Self>, app: Arc<App>) {
        let socket = match beacon_socket() {
            Ok(s) => Arc::new(s),
            Err(e) => {
                app.logs.warn(format!("Rede local: não foi possível abrir a porta UDP {BEACON_PORT} ({e}); outros PCs não vão te ver"));
                return;
            }
        };
        app.logs.info(format!("Rede local: anunciando este PC (nó {}) na porta UDP {BEACON_PORT}", &self.node_id[..8]));
        let shutdown = app.hub.shutdown.clone();

        // Escuta
        let (lan, app2, sock, stop) = (self.clone(), app.clone(), socket.clone(), shutdown.clone());
        tokio::spawn(async move {
            let mut buf = vec![0u8; MAX_BEACON];
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    r = sock.recv_from(&mut buf) => {
                        let Ok((n, from)) = r else { continue };
                        let Ok(beacon) = serde_json::from_slice::<Beacon>(&buf[..n]) else { continue };
                        if beacon.app != "padospeak" || beacon.node == lan.node_id {
                            continue;
                        }
                        if lan.see(from.ip(), beacon) {
                            app2.hub.to_all("lan:peers", lan.peers());
                        }
                    }
                }
            }
        });

        // Anúncio + limpeza
        let (lan, stop) = (self.clone(), shutdown);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(ANNOUNCE_EVERY);
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tick.tick() => {}
                }
                if lan.sweep() {
                    app.hub.to_all("lan:peers", lan.peers());
                }
                let beacon = Beacon {
                    app: "padospeak".into(),
                    v: 1,
                    node: lan.node_id.clone(),
                    port: lan.port,
                    users: announced_users(&app).await,
                    hosting: lan.hosting.lock().unwrap().clone(),
                };
                let Ok(bytes) = serde_json::to_vec(&beacon) else { continue };
                for target in broadcast_targets() {
                    let _ = socket.send_to(&bytes, SocketAddr::new(IpAddr::V4(target), BEACON_PORT)).await;
                }
            }
        });
    }
}

fn url_host(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => format!("[{v6}]"),
        },
        IpAddr::V4(v4) => v4.to_string(),
    }
}

/// Socket UDP com reuso de porta: vários nós no mesmo PC (testes, perfis diferentes) escutam juntos.
fn beacon_socket() -> std::io::Result<tokio::net::UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    s.set_broadcast(true)?;
    s.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), BEACON_PORT).into())?;
    s.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(s.into())
}

/// Broadcast geral e o de cada rede /24 das placas do PC (o Windows só manda o geral por uma placa).
fn broadcast_targets() -> Vec<Ipv4Addr> {
    let mut list = vec![Ipv4Addr::BROADCAST];
    for ip in crate::tls::lan_addresses() {
        if let IpAddr::V4(v4) = ip {
            let [a, b, c, _] = v4.octets();
            let bcast = Ipv4Addr::new(a, b, c, 255);
            if !list.contains(&bcast) {
                list.push(bcast);
            }
        }
    }
    list
}

/// Perfis locais online e visíveis (quem escolheu "aparecer offline" não é anunciado).
async fn announced_users(app: &App) -> Vec<BeaconUser> {
    let online = app.hub.visible_users();
    let mut out = Vec::new();
    for (id, status) in online {
        let row = app
            .db
            .query_one(
                "SELECT id, username, display_name, avatar_color, avatar_at, bio, name_color, bio_color, banner_color FROM users \
                 WHERE id = ?1 AND origin = 'local'",
                [id.as_str()],
                |r| {
                    Ok(BeaconUser {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        display_name: r.get(2)?,
                        avatar_color: r.get(3)?,
                        avatar_at: r.get(4)?,
                        bio: r.get::<Option<String>>(5)?.unwrap_or_default(),
                        name_color: r.get(6)?,
                        bio_color: r.get(7)?,
                        banner_color: r.get(8)?,
                        status: status.clone(),
                    })
                },
            )
            .await
            .ok()
            .flatten();
        if let Some(u) = row {
            out.push(u);
        }
    }
    out
}

// ---------- Rotas ----------

pub fn router() -> Router<Arc<App>> {
    Router::new().route("/api/lan/session", post(session)).route("/api/lan/peers", get(peers))
}

fn err(status: StatusCode, msg: &str) -> ApiError {
    ApiError::new(status, msg)
}

async fn peers(State(app): State<Arc<App>>, AuthUser(me, _): AuthUser) -> Result<Json<Vec<LanPeer>>, ApiError> {
    let Some(lan) = &app.lan else { return Err(err(StatusCode::NOT_FOUND, "Este servidor não é um nó local")) };
    if me.lan {
        return Err(err(StatusCode::FORBIDDEN, "Só o perfil deste PC vê a rede local"));
    }
    Ok(Json(lan.peers()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionBody {
    user_id: String,
    username: String,
    display_name: String,
    #[serde(default)]
    avatar_color: String,
    #[serde(default)]
    bio: String,
    name_color: Option<String>,
    bio_color: Option<String>,
    #[serde(default)]
    banner_color: Option<String>,
    /// Chave secreta do PC de quem entra (fixada na primeira conexão).
    key: String,
}

fn clean_color(c: Option<String>) -> Option<String> {
    c.map(|c| c.trim().to_string()).filter(|c| valid_color(c))
}

/// Entrada de um perfil de outro PC da rede como convidado deste nó.
async fn session(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<SessionBody>,
) -> Result<Json<Value>, ApiError> {
    if app.lan.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "Este servidor não é um nó local"));
    }
    if !is_private(addr.ip()) {
        return Err(err(StatusCode::FORBIDDEN, "Só aceita perfis da rede local"));
    }
    let id = body.user_id.trim().to_string();
    if id.is_empty() || id.len() > 64 || body.key.len() < 16 {
        return Err(err(StatusCode::BAD_REQUEST, "Perfil inválido"));
    }
    let display_name = fit_formatted(&body.display_name, NAME_MAX, NAME_RAW_MAX)
        .filter(|d| visible_len(d) > 0)
        .unwrap_or_else(|| body.username.clone());
    let bio = fit_formatted(&body.bio, BIO_MAX, BIO_RAW_MAX).unwrap_or_default();
    let avatar_color = clean_color(Some(body.avatar_color)).unwrap_or_else(|| "#3a8ee0".into());
    let (name_color, bio_color) = (clean_color(body.name_color), clean_color(body.bio_color));
    let banner_color = clean_color(body.banner_color);

    let existing = app
        .db
        .query_one("SELECT origin, lan_key_hash FROM users WHERE id = ?1", [id.as_str()], |r| {
            Ok((r.get::<String>(0)?, r.get::<Option<String>>(1)?))
        })
        .await?;
    match &existing {
        Some((origin, _)) if origin != "lan" => {
            return Err(err(StatusCode::FORBIDDEN, "Esse perfil pertence a este PC"));
        }
        Some((_, Some(hash))) => {
            if !crate::auth::verify_password(body.key.clone(), hash.clone()).await {
                return Err(err(StatusCode::FORBIDDEN, "Esse perfil já entrou aqui de outro PC"));
            }
        }
        _ => {}
    }
    let key_hash = crate::auth::hash_password(body.key).await;
    if existing.is_some() {
        app.db
            .execute(
                "UPDATE users SET display_name = ?1, bio = ?2, avatar_color = ?3, name_color = ?4, bio_color = ?5, \
                 lan_key_hash = COALESCE(lan_key_hash, ?6), banner_color = ?8 WHERE id = ?7",
                libsql::params![display_name.as_str(), bio.as_str(), avatar_color.as_str(), name_color, bio_color, key_hash, id.as_str(), banner_color],
            )
            .await?;
    } else {
        let username = free_username(&app, &body.username).await?;
        app.db
            .execute(
                "INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at, bio, name_color, \
                 bio_color, origin, lan_key_hash, banner_color) VALUES (?1, ?2, ?3, '!lan', ?4, ?5, ?6, ?7, ?8, 'lan', ?9, ?10)",
                libsql::params![
                    id.as_str(),
                    username,
                    display_name.as_str(),
                    avatar_color.as_str(),
                    crate::now_ms(),
                    bio.as_str(),
                    name_color,
                    bio_color,
                    key_hash,
                    banner_color
                ],
            )
            .await?;
    }
    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.id = ?1");
    let user: User = app
        .db
        .query_one(&sql, [id.as_str()], user_from_row)
        .await?
        .ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "Erro ao criar o perfil"))?;
    app.hub.to_all("user:updated", &user);
    let token = crate::auth::create_session(&app.db, &user.id).await?;
    Ok(Json(json!({ "token": token, "user": user })))
}

/// Nome de usuário livre neste nó (outro PC pode ter escolhido o mesmo nome).
async fn free_username(app: &App, wanted: &str) -> Result<String, ApiError> {
    let base: String = wanted.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.').take(20).collect();
    let base = if base.len() < 3 { "convidado".to_string() } else { base };
    for n in 1..100 {
        let candidate = if n == 1 { base.clone() } else { format!("{base}_{n}") };
        let taken = app.db.query_one("SELECT 1 FROM users WHERE username = ?1", [candidate.as_str()], |_| Ok(())).await?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}_{}", &uuid::Uuid::new_v4().simple().to_string()[..6]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_rede_local() {
        for ok in ["127.0.0.1", "192.168.0.4", "10.1.2.3", "172.20.0.1", "169.254.1.1", "::1", "fe80::1", "fd00::5"] {
            assert!(is_private(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "172.32.0.1", "2001:db8::1", "200.1.2.3"] {
            assert!(!is_private(no.parse().unwrap()), "{no}");
        }
        assert!(is_private("::ffff:192.168.1.9".parse().unwrap()));
    }

    #[test]
    fn lista_e_expira() {
        let lan = Lan::new("eu".into(), 47821, None);
        let beacon = |users: Vec<BeaconUser>| Beacon { app: "padospeak".into(), v: 1, node: "outro".into(), port: 47821, users, hosting: None };
        let ana = BeaconUser {
            id: "a1".into(),
            username: "ana".into(),
            display_name: "Ana".into(),
            avatar_color: "#3a8ee0".into(),
            avatar_at: Some(5),
            bio: String::new(),
            name_color: None,
            bio_color: None,
            banner_color: None,
            status: "online".into(),
        };
        assert!(lan.see("192.168.0.9".parse().unwrap(), beacon(vec![ana.clone()])));
        assert!(!lan.see("192.168.0.9".parse().unwrap(), beacon(vec![ana])));
        let p = &lan.peers()[0];
        assert_eq!(p.node_url, "http://192.168.0.9:47821");
        assert_eq!(p.avatar_url.as_deref(), Some("http://192.168.0.9:47821/api/users/a1/avatar?v=5"));
        lan.peers.lock().unwrap().get_mut("outro").unwrap().seen = Instant::now() - EXPIRE_AFTER;
        assert!(lan.sweep());
        assert!(lan.peers().is_empty());
    }
}
