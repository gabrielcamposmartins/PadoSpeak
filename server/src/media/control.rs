//! Canal de controle entre o servidor principal e um nó de mídia (`/api/media/control`).
//!
//! O nó sempre liga para o principal (um laptop atrás do roteador não precisa de porta aberta para isso).
//! A primeira mensagem é o `hello`, assinado com o segredo do pareamento:
//!
//! - nó → principal: `{ t: "hello", id, ts, nonce, mac, version, caps, udpPort, lan }`
//! - principal → nó: `{ t: "welcome", publicIp, bootId }` ou `{ t: "refused", error }`
//!
//! Depois, mensagens JSON nos dois sentidos:
//!
//! - `{ t: "cmd", op, d }`: comando sem resposta (SFU: `join`, `answer`, `want`, `leave`, `rekey`, `keyframe`).
//! - `{ t: "req", id, op, d }` → `{ t: "res", id, d }`: pedido com resposta (`publish`, `pot`, `music.resolve`).
//! - `{ t: "ev", conn, msg }`: evento do SFU para uma conexão do principal (o principal repassa).
//! - `{ t: "beat", load }`: a cada `BEAT_EVERY`, nos dois sentidos (o nó manda a carga).
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const BEAT_EVERY: std::time::Duration = std::time::Duration::from_secs(1);
/// Sem batimento por este tempo, o outro lado caiu.
pub const DEAD_AFTER: std::time::Duration = std::time::Duration::from_secs(3);
/// Diferença máxima de relógio aceita no `hello`.
pub const CLOCK_SKEW_MS: i64 = 60_000;
const CODE_PREFIX: &str = "psm1.";
const MAC_LABEL: &str = "padospeak-midia";

/// O que o nó precisa para ligar para o principal (vai no código de pareamento).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pairing {
    /// Endereço do servidor principal (`https://…`).
    #[serde(rename = "u")]
    pub url: String,
    #[serde(rename = "i")]
    pub id: String,
    #[serde(rename = "s")]
    pub secret: String,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

impl Pairing {
    pub fn encode(&self) -> String {
        format!("{CODE_PREFIX}{}", b64().encode(serde_json::to_vec(self).unwrap_or_default()))
    }

    pub fn decode(code: &str) -> Result<Self, String> {
        let body = code.trim().strip_prefix(CODE_PREFIX).ok_or("Código de pareamento inválido")?;
        let raw = b64().decode(body).map_err(|_| "Código de pareamento inválido")?;
        let p: Pairing = serde_json::from_slice(&raw).map_err(|_| "Código de pareamento inválido")?;
        if p.id.is_empty() || p.secret.len() < 32 || !(p.url.starts_with("http://") || p.url.starts_with("https://")) {
            return Err("Código de pareamento incompleto".into());
        }
        Ok(p)
    }

    /// `wss://…/api/media/control` (ou `ws://`).
    pub fn control_url(&self) -> String {
        format!("{}/api/media/control", ws_base(&self.url))
    }
}

/// `https://x` → `wss://x` (sem a barra do fim).
pub fn ws_base(url: &str) -> String {
    let url = url.trim_end_matches('/');
    match url.strip_prefix("https://") {
        Some(rest) => format!("wss://{rest}"),
        None => format!("ws://{}", url.strip_prefix("http://").unwrap_or(url)),
    }
}

/// Segredo novo de um nó (256 bits).
pub fn new_secret() -> String {
    use ring::rand::SecureRandom;
    let mut buf = [0u8; 32];
    ring::rand::SystemRandom::new().fill(&mut buf).expect("gerador aleatório do sistema");
    b64().encode(buf)
}

fn key(secret: &str) -> ring::hmac::Key {
    ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes())
}

fn message(id: &str, ts: i64, nonce: &str) -> String {
    format!("{MAC_LABEL}|{id}|{ts}|{nonce}")
}

/// Assinatura do `hello`.
pub fn mac(secret: &str, id: &str, ts: i64, nonce: &str) -> String {
    b64().encode(ring::hmac::sign(&key(secret), message(id, ts, nonce).as_bytes()).as_ref())
}

/// Confere a assinatura (em tempo constante) e o relógio.
pub fn verify(secret: &str, id: &str, ts: i64, nonce: &str, mac: &str, now_ms: i64) -> Result<(), &'static str> {
    if (now_ms - ts).abs() > CLOCK_SKEW_MS {
        return Err("O relógio do nó está muito diferente do relógio do servidor");
    }
    if nonce.len() < 16 || nonce.len() > 64 {
        return Err("Pedido inválido");
    }
    let tag = b64().decode(mac).map_err(|_| "Assinatura inválida")?;
    ring::hmac::verify(&key(secret), message(id, ts, nonce).as_bytes(), &tag).map_err(|_| "Assinatura inválida")
}

/// O `hello` do nó.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub id: String,
    pub ts: i64,
    pub nonce: String,
    pub mac: String,
    #[serde(default)]
    pub version: String,
    /// `sfu`, `pot` (token do YouTube), `music` (busca a música pelo nó).
    #[serde(default)]
    pub caps: Vec<String>,
    #[serde(default)]
    pub udp_port: u16,
    #[serde(default)]
    pub lan: Vec<String>,
}

impl Hello {
    pub fn new(pairing: &Pairing, caps: Vec<String>, udp_port: u16, lan: Vec<String>, now_ms: i64) -> Self {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        Self {
            mac: mac(&pairing.secret, &pairing.id, now_ms, &nonce),
            id: pairing.id.clone(),
            ts: now_ms,
            nonce,
            version: env!("CARGO_PKG_VERSION").into(),
            caps,
            udp_port,
            lan,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codigo_de_pareamento_vai_e_volta() {
        let p = Pairing { url: "https://padospeak.padoru.org".into(), id: "n1".into(), secret: new_secret() };
        let code = p.encode();
        assert!(code.starts_with("psm1."));
        assert_eq!(Pairing::decode(&code).unwrap(), p);
        assert_eq!(p.control_url(), "wss://padospeak.padoru.org/api/media/control");
        assert!(Pairing::decode("psm1.xxx").is_err());
        assert!(Pairing::decode("outra coisa").is_err());
        let fraco = Pairing { secret: "curto".into(), ..p.clone() };
        assert!(Pairing::decode(&fraco.encode()).is_err());
    }

    #[test]
    fn segredos_diferentes_e_longos() {
        let a = new_secret();
        assert_ne!(a, new_secret());
        assert!(a.len() >= 43);
    }

    #[test]
    fn assinatura_confere_relogio_e_segredo() {
        let secret = new_secret();
        let now = 1_000_000_000;
        let nonce = "0123456789abcdef0123";
        let m = mac(&secret, "n1", now, nonce);
        assert!(verify(&secret, "n1", now, nonce, &m, now + 5_000).is_ok());
        assert!(verify(&secret, "n1", now, nonce, &m, now + CLOCK_SKEW_MS + 1).is_err());
        assert!(verify(&new_secret(), "n1", now, nonce, &m, now).is_err());
        assert!(verify(&secret, "n2", now, nonce, &m, now).is_err());
        assert!(verify(&secret, "n1", now, "curto", &m, now).is_err());
    }

    #[test]
    fn enderecos_do_websocket() {
        assert_eq!(ws_base("http://192.168.0.5:3000/"), "ws://192.168.0.5:3000");
        assert_eq!(ws_base("https://x.org"), "wss://x.org");
    }
}
