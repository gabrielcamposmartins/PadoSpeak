//! TURN (relay das chamadas): quando duas pessoas não conseguem se conectar direto (CGNAT, 4G, redes de
//! empresa/faculdade), a voz passa por um servidor TURN (coturn). As senhas são temporárias e por
//! usuário, no formato "TURN REST API" do coturn (`use-auth-secret`): usuário = `<expira>:<id>`,
//! senha = base64(HMAC-SHA1(segredo, usuário)). Só quem está logado recebe (no `ready` do WebSocket).
//!
//! Variáveis: `TURN_URLS` (ex.: `turns:turn.exemplo.org:443?transport=tcp`, separadas por vírgula) e
//! `TURN_SECRET` (o mesmo `static-auth-secret` do coturn).
use base64::Engine;
use serde_json::{json, Value};

/// Validade da senha. A renovação acontece a cada reconexão do WebSocket.
const TTL_SECS: i64 = 24 * 3600;

#[derive(Clone)]
pub struct Turn {
    urls: Vec<String>,
    secret: String,
}

impl Turn {
    pub fn from_env() -> Option<Self> {
        let urls: Vec<String> = std::env::var("TURN_URLS")
            .ok()?
            .split(',')
            .map(|u| u.trim().to_string())
            .filter(|u| u.starts_with("turn:") || u.starts_with("turns:"))
            .collect();
        let secret = std::env::var("TURN_SECRET").ok().filter(|s| !s.trim().is_empty())?;
        (!urls.is_empty()).then_some(Self { urls, secret: secret.trim().to_string() })
    }

    /// RTCIceServer com senha válida por 24 h para este usuário.
    pub fn ice_server(&self, user_id: &str, now_ms: i64) -> Value {
        let username = format!("{}:{user_id}", now_ms / 1000 + TTL_SECS);
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, self.secret.as_bytes());
        let credential = base64::engine::general_purpose::STANDARD.encode(ring::hmac::sign(&key, username.as_bytes()));
        json!({ "urls": self.urls, "username": username, "credential": credential })
    }

    pub fn urls(&self) -> &[String] {
        &self.urls
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn senha_no_formato_do_coturn() {
        let t = Turn { urls: vec!["turns:turn.x:443?transport=tcp".into()], secret: "segredo".into() };
        let v = t.ice_server("u1", 1_000_000);
        assert_eq!(v["username"], "87400:u1");
        // Conferido com: printf '87400:u1' | openssl dgst -sha1 -hmac segredo -binary | base64
        assert_eq!(v["credential"], "mFwP8nQhewKS+vfrQlfFVSKsmMM=");
    }
}
