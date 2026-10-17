//! Notificações push (Web Push) para quem usa o PadoSpeak pelo navegador ou instalado como app no
//! celular: chegam com o app fechado ou em segundo plano. Só no servidor de comunidade (o nó local
//! do app desktop usa as notificações do Windows).
//!
//! As chaves VAPID são criadas na primeira vez e guardadas cifradas no banco (`settings`).
use crate::api::{ApiError, AuthUser};
use crate::db::Db;
use crate::host::App;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};
use web_push_native::p256::PublicKey;
use web_push_native::{Auth, WebPushBuilder};

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

const KEY_SETTING: &str = "vapid_private";
/// Contato exigido pelo VAPID (os serviços de push usam para avisar sobre abuso).
const SUBJECT: &str = "https://github.com/gabrielcamposmartins/PadoSpeak";

pub struct Push {
    key: ES256KeyPair,
    /// Chave pública (ponto não comprimido, base64url) que o navegador usa para se inscrever.
    pub public_key: String,
    http: reqwest::Client,
    db: Db,
}

/// O que aparece na notificação.
pub struct Note {
    pub title: String,
    pub body: String,
    /// Notificações com a mesma tag se substituem (ex.: várias mensagens da mesma conversa).
    pub tag: String,
    /// Para onde o app vai ao tocar na notificação.
    pub url: String,
    /// "message", "call", "nudge", "friend" ou "guild": o celular escolhe a vibração (a chamada toca
    /// até a pessoa atender ou recusar).
    pub kind: &'static str,
    /// Quem fez (a foto vira o ícone da notificação).
    pub from: Option<Sender>,
}

/// Foto de quem mandou; sem foto, o aparelho desenha a inicial na cor da pessoa.
pub struct Sender {
    /// De quem é a foto (para "esconder meu perfil de").
    pub owner: String,
    pub avatar: Option<String>,
    pub color: String,
    pub initial: String,
}

impl Sender {
    pub fn of(user: &crate::models::User) -> Option<Self> {
        let name = crate::models::plain_text(&user.display_name);
        let initial = name.trim().chars().next().or_else(|| user.username.chars().next()).unwrap_or('?');
        Some(Self { owner: user.id.clone(), avatar: user.avatar_url.clone(), color: user.avatar_color.clone(), initial: initial.to_uppercase().collect() })
    }
}

impl Note {
    pub fn payload(&self) -> Value {
        let mut v = json!({ "title": self.title, "body": self.body, "tag": self.tag, "url": self.url, "kind": self.kind });
        if let Some(f) = &self.from {
            v["icon"] = json!(f.avatar);
            v["color"] = json!(f.color);
            v["initial"] = json!(f.initial);
        }
        v
    }
}

impl Push {
    pub async fn load(db: &Db) -> Result<Arc<Self>, crate::BoxError> {
        let key = match db.get_setting(KEY_SETTING).await? {
            Some(sealed) => ES256KeyPair::from_bytes(&B64URL.decode(db.cipher.reveal(&sealed))?)?,
            None => {
                let key = ES256KeyPair::generate();
                db.set_setting(KEY_SETTING, &db.cipher.seal(&B64URL.encode(key.to_bytes()))).await?;
                key
            }
        };
        let public_key = B64URL.encode(key.public_key().public_key().to_bytes_uncompressed());
        let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()?;
        Ok(Arc::new(Self { key, public_key, http, db: db.clone() }))
    }

    /// Envia a notificação para todos os aparelhos inscritos da pessoa (em segundo plano).
    pub fn send(self: &Arc<Self>, user_id: &str, note: Note) {
        let me = self.clone();
        let user_id = user_id.to_string();
        tokio::spawn(async move {
            // Ocupado: só as ligações chegam.
            if note.kind != "call" {
                let status = me
                    .db
                    .query_one("SELECT status FROM users WHERE id = ?1", [user_id.as_str()], |r| r.get::<String>(0))
                    .await
                    .ok()
                    .flatten();
                if status.as_deref() == Some("busy") {
                    return;
                }
            }
            let subs = me
                .db
                .query_all(
                    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1",
                    [user_id.as_str()],
                    |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<String>(2)?)),
                )
                .await
                .unwrap_or_default();
            let payload = note.payload().to_string();
            for (endpoint, p256dh, auth) in subs {
                match me.deliver(&endpoint, &p256dh, &auth, &payload).await {
                    // Inscrição cancelada ou vencida: o aparelho não quer mais avisos.
                    Ok(404 | 410) => {
                        let _ = me.db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?1", [endpoint.as_str()]).await;
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[push] {endpoint}: {e}"),
                }
            }
        });
    }

    async fn deliver(&self, endpoint: &str, p256dh: &str, auth: &str, payload: &str) -> Result<u16, crate::BoxError> {
        let (parts, body) = build_request(&self.key, endpoint, p256dh, auth, payload)?.into_parts();
        let mut req = self.http.post(parts.uri.to_string()).body(body);
        for (name, value) in parts.headers.iter() {
            req = req.header(name.as_str(), value.as_bytes());
        }
        // Mensagens de conversa não podem esperar dias: o serviço descarta depois de um dia.
        let res = req.header("TTL", "86400").header("Urgency", "high").send().await?;
        Ok(res.status().as_u16())
    }
}

/// Monta o pedido HTTP do push: conteúdo cifrado para o aparelho (RFC 8291) e assinatura VAPID.
fn build_request(
    key: &ES256KeyPair,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &str,
) -> Result<axum::http::Request<Vec<u8>>, crate::BoxError> {
    let ua_public = PublicKey::from_sec1_bytes(&B64URL.decode(p256dh)?)?;
    let ua_auth = B64URL.decode(auth)?;
    if ua_auth.len() != 16 {
        return Err("auth inválido".into());
    }
    Ok(WebPushBuilder::new(endpoint.parse()?, ua_public, Auth::clone_from_slice(&ua_auth))
        .with_valid_duration(Duration::from_secs(12 * 3600))
        .with_vapid(key, SUBJECT)
        .build(payload.as_bytes().to_vec())
        .map_err(|e| format!("{e:?}"))?)
}

impl App {
    /// Notificação push para quem não está com o PadoSpeak aberto na tela.
    pub fn push_to(&self, user_id: &str, mut note: Note) {
        if let Some(from) = note.from.as_mut() {
            // "Esconder meu perfil de": quem está na lista vê a inicial. E a foto de quem tem a lista
            // pede login, que o ícone da notificação não tem: aí vai a inicial para todos.
            if self.privacy.hides(&from.owner, user_id) || self.privacy.has_list(&from.owner) {
                from.avatar = None;
            }
        }
        if let Some(push) = &self.push {
            if !self.hub.is_watching(user_id) {
                push.send(user_id, note);
            }
        }
    }
}

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/push/key", get(public_key))
        .route("/api/push/subscribe", axum::routing::post(subscribe).delete(unsubscribe))
}

async fn public_key(State(app): AppState) -> Json<Value> {
    Json(json!({ "publicKey": app.push.as_ref().map(|p| p.public_key.clone()) }))
}

#[derive(Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
struct SubscriptionBody {
    endpoint: String,
    #[serde(default)]
    keys: Option<SubscriptionKeys>,
}

async fn subscribe(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<SubscriptionBody>) -> ApiResult<StatusCode> {
    let bad = |m: &str| ApiError(StatusCode::BAD_REQUEST, m.into());
    if app.push.is_none() {
        return Err(ApiError(StatusCode::NOT_FOUND, "Este servidor não envia notificações push".into()));
    }
    let keys = body.keys.ok_or_else(|| bad("Inscrição sem chaves"))?;
    if !body.endpoint.starts_with("https://") || body.endpoint.len() > 1000 {
        return Err(bad("Endereço de notificação inválido"));
    }
    if B64URL.decode(&keys.p256dh).map(|k| k.len()).unwrap_or(0) != 65 || B64URL.decode(&keys.auth).map(|k| k.len()).unwrap_or(0) != 16 {
        return Err(bad("Chaves de notificação inválidas"));
    }
    app.db
        .execute(
            "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
            libsql::params![body.endpoint.as_str(), me.id.as_str(), keys.p256dh.as_str(), keys.auth.as_str(), crate::now_ms()],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unsubscribe(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<SubscriptionBody>) -> ApiResult<StatusCode> {
    app.db
        .execute("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2", [body.endpoint.as_str(), me.id.as_str()])
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_push_native::p256::elliptic_curve::sec1::ToEncodedPoint;
    use web_push_native::p256::SecretKey;

    #[test]
    fn aparelho_consegue_abrir_a_notificacao() {
        let vapid = ES256KeyPair::generate();
        // Chaves do "aparelho", como o navegador gera em pushManager.subscribe().
        let ua_secret = SecretKey::from_slice(&[7u8; 32]).unwrap();
        let p256dh = B64URL.encode(ua_secret.public_key().to_encoded_point(false).as_bytes());
        let auth = [3u8; 16];
        let payload = r#"{"title":"Bia","body":"oi! 🎸","tag":"dm:1","url":"/?dm=1"}"#;
        let req = build_request(&vapid, "https://fcm.googleapis.com/fcm/send/abc", &p256dh, &B64URL.encode(auth), payload).unwrap();
        assert_eq!(req.headers()["content-encoding"], "aes128gcm");
        assert!(req.headers()["authorization"].to_str().unwrap().starts_with("vapid t="));
        assert!(!String::from_utf8_lossy(req.body()).contains("Bia"), "conteúdo vai cifrado");
        let opened = web_push_native::decrypt(req.body().clone(), &ua_secret, &Auth::clone_from_slice(&auth)).unwrap();
        assert_eq!(String::from_utf8(opened).unwrap(), payload);
    }

    #[test]
    fn notificacao_leva_a_foto_de_quem_mandou() {
        let mut bia = crate::models::User {
            id: "u1".into(),
            username: "bia".into(),
            display_name: "[cor=#ff0000]**bia**[/cor]".into(),
            avatar_color: "#3366cc".into(),
            avatar_url: Some("/api/users/u1/avatar?v=5".into()),
            bio: String::new(),
            name_color: None,
            bio_color: None,
            banner_color: None,
            lan: false,
            message_color: None,
        };
        let note = |from| Note { title: "Bia".into(), body: "oi".into(), tag: "dm:1".into(), url: "/?dm=1".into(), kind: "message", from };
        let v = note(Sender::of(&bia)).payload();
        assert_eq!(v["kind"], "message");
        assert_eq!(v["icon"], "/api/users/u1/avatar?v=5");
        assert_eq!(v["initial"], "B");
        bia.avatar_url = None;
        let v = note(Sender::of(&bia)).payload();
        assert!(v["icon"].is_null());
        assert_eq!(v["color"], "#3366cc");
        // Aviso do sistema (sem pessoa): o ícone do PadoSpeak.
        assert!(note(None).payload().get("initial").is_none());
    }
}
