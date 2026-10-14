//! Criptografia das mensagens guardadas no banco (AES-256-GCM).
//!
//! O texto vai para o banco como `enc1:<base64(nonce ‖ cifrado ‖ tag)>`; quem lê o banco sem a chave
//! não vê as conversas. A chave vem de `MESSAGE_KEY` (base64 de 32 bytes, ex.: no env da VM) ou,
//! sem ela, do arquivo `chave-mensagens.key` na pasta de dados, criado na primeira vez.
//! Mensagens antigas em texto puro continuam legíveis e são cifradas na migração (`Db::encrypt_legacy`).
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use std::path::Path;
use std::sync::Arc;

const PREFIX: &str = "enc1:";
const KEY_FILE: &str = "chave-mensagens.key";
/// O que aparece no lugar de uma mensagem que não dá para abrir (chave trocada ou perdida).
pub const UNREADABLE: &str = "[mensagem protegida: a chave de criptografia deste servidor mudou]";

#[derive(Clone)]
pub struct Cipher {
    key: Arc<LessSafeKey>,
    rng: SystemRandom,
    /// Impressão digital da chave (para avisar se ela mudar com mensagens já cifradas).
    pub fingerprint: String,
}

impl Cipher {
    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, bytes).expect("chave AES-256"));
        let fingerprint = B64.encode(&digest(&SHA256, bytes).as_ref()[..12]);
        Self { key: Arc::new(key), rng: SystemRandom::new(), fingerprint }
    }

    /// `MESSAGE_KEY` do ambiente ou o arquivo de chave da pasta de dados (criado se não existir).
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        if let Some(v) = std::env::var("MESSAGE_KEY").ok().filter(|v| !v.trim().is_empty()) {
            return Self::decode(v.trim()).ok_or_else(|| "MESSAGE_KEY inválida: use base64 de 32 bytes (openssl rand -base64 32)".into());
        }
        let path = data_dir.join(KEY_FILE);
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Self::decode(text.trim()).ok_or_else(|| format!("{} está corrompido", path.display()));
        }
        let mut bytes = [0u8; 32];
        SystemRandom::new().fill(&mut bytes).map_err(|_| "sem gerador aleatório do sistema")?;
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        std::fs::write(&path, B64.encode(bytes)).map_err(|e| format!("não foi possível salvar {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Self::from_bytes(&bytes))
    }

    fn decode(text: &str) -> Option<Self> {
        let bytes: [u8; 32] = B64.decode(text).ok()?.try_into().ok()?;
        Some(Self::from_bytes(&bytes))
    }

    pub fn is_sealed(stored: &str) -> bool {
        stored.starts_with(PREFIX)
    }

    /// Texto → forma guardada no banco.
    pub fn seal(&self, plain: &str) -> String {
        let mut nonce = [0u8; NONCE_LEN];
        self.rng.fill(&mut nonce).expect("gerador aleatório do sistema");
        let mut data = plain.as_bytes().to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
            .expect("cifrar mensagem");
        let mut out = nonce.to_vec();
        out.extend_from_slice(&data);
        format!("{PREFIX}{}", B64.encode(out))
    }

    /// Bytes → `nonce ‖ cifrado ‖ tag` (arquivos, em pedaços).
    pub fn seal_bytes(&self, plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        self.rng.fill(&mut nonce).expect("gerador aleatório do sistema");
        let mut data = plain.to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
            .expect("cifrar arquivo");
        let mut out = nonce.to_vec();
        out.extend_from_slice(&data);
        out
    }

    pub fn open_bytes(&self, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < NONCE_LEN {
            return None;
        }
        let (nonce, data) = sealed.split_at(NONCE_LEN);
        let mut data = data.to_vec();
        let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
        Some(self.key.open_in_place(nonce, Aad::empty(), &mut data).ok()?.to_vec())
    }

    /// Forma guardada → texto. Mensagens antigas (sem prefixo) passam direto.
    pub fn reveal(&self, stored: &str) -> String {
        let Some(body) = stored.strip_prefix(PREFIX) else { return stored.to_string() };
        self.try_reveal(body).unwrap_or_else(|| UNREADABLE.to_string())
    }

    fn try_reveal(&self, body: &str) -> Option<String> {
        let raw = B64.decode(body).ok()?;
        if raw.len() < NONCE_LEN {
            return None;
        }
        let (nonce, sealed) = raw.split_at(NONCE_LEN);
        let mut data = sealed.to_vec();
        let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
        let plain = self.key.open_in_place(nonce, Aad::empty(), &mut data).ok()?;
        String::from_utf8(plain.to_vec()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cifra_e_abre() {
        let c = Cipher::from_bytes(&[7u8; 32]);
        let sealed = c.seal("oi, tudo bem? 🎸 [cor=#d93f3a]x[/cor]");
        assert!(Cipher::is_sealed(&sealed));
        assert!(!sealed.contains("tudo bem"));
        assert_ne!(sealed, c.seal("oi, tudo bem? 🎸 [cor=#d93f3a]x[/cor]"), "nonce novo a cada vez");
        assert_eq!(c.reveal(&sealed), "oi, tudo bem? 🎸 [cor=#d93f3a]x[/cor]");
        assert_eq!(c.reveal("mensagem antiga"), "mensagem antiga");
        let other = Cipher::from_bytes(&[8u8; 32]);
        assert_eq!(other.reveal(&sealed), UNREADABLE);
        assert_ne!(c.fingerprint, other.fingerprint);
    }

    #[test]
    fn chave_em_arquivo_e_reaproveitada() {
        let dir = std::env::temp_dir().join(format!("padospeak-key-{}", uuid::Uuid::new_v4()));
        let a = Cipher::load(&dir).unwrap();
        let b = Cipher::load(&dir).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(b.reveal(&a.seal("x")), "x");
        let _ = std::fs::remove_dir_all(dir);
    }
}
