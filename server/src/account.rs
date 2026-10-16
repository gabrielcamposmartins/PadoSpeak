//! Conta: e-mail (para entrar com ele e receber o código de "esqueci a senha") e login com o Google.
//!
//! - **E-mail**: só entra na conta depois de confirmado (código de 6 dígitos mandado para ele). Com ele dá
//!   para entrar no lugar do usuário e pedir um código de recuperação de senha.
//! - **Esqueci a senha**: o código (ABCD-EFGH) vale 30 min *no lugar* da senha e não troca a senha atual
//!   (ninguém tranca a conta de outra pessoa pedindo códigos). Entrando com ele, a pessoa cria uma senha
//!   nova (o mesmo caminho da senha redefinida pelo administrador).
//! - **Google** (OAuth 2.0, código trocado no servidor): o app abre a página do Google numa janela (no app
//!   do Windows, no navegador do sistema) e pergunta ao servidor até o login terminar
//!   (`/api/auth/google/poll`). Conta que já existe é achada pelo Google vinculado ou pelo e-mail
//!   confirmado igual ao do Google; sem conta, uma nova é criada.
//!
//! Variáveis: `SMTP_URL` (ex.: `smtps://usuario:senha@smtp.gmail.com:465`), `MAIL_FROM`
//! (ex.: `PadoSpeak <no-reply@exemplo.org>`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `PUBLIC_URL`
//! (endereço público do servidor, para o retorno do Google).
use crate::api::{ApiError, AuthUser};
use crate::auth;
use crate::host::App;
use crate::models::{user_from_row, User, USER_COLS};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Senha de quem entrou só pelo Google: nunca confere (bcrypt recusa) — entra pelo Google ou pelo
/// "esqueci a senha" (com o e-mail).
pub const NO_PASSWORD: &str = "!";
const EMAIL_CODE_MS: i64 = 15 * 60_000;
const RESET_CODE_MS: i64 = 30 * 60_000;
const CODE_ATTEMPTS: i64 = 5;
const RESEND_MS: i64 = 60_000;
/// Códigos de confirmação de e-mail por conta por dia (sem isso dá para chutar o código pedindo outro a
/// cada minuto, e para usar o servidor para mandar e-mail a qualquer endereço).
const EMAIL_CODES_PER_DAY: u32 = 5;
const OAUTH_TTL_MS: i64 = 10 * 60_000;
/// Tentativas de digitar o código do login com o Google no app.
const CONFIRM_ATTEMPTS: u8 = 5;
/// Cookie que liga o login com o Google ao navegador que começou (veja `google_begin`).
const BIND_COOKIE: &str = "ps_gbind";

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn bad(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}

// ---------- E-mail ----------

pub struct Mailer {
    smtp: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    /// Teto de e-mails por dia (`MAIL_DAILY_LIMIT`): quem entrega costuma ser uma conta pessoal (o
    /// Gmail aceita uns 500 por dia), e passar disso pode suspender a conta.
    daily_limit: u32,
    /// (dia, quantos já foram hoje)
    sent: Mutex<(i64, u32)>,
}

fn today() -> i64 {
    crate::now_ms() / 86_400_000
}

impl Mailer {
    pub fn from_env() -> Option<Self> {
        let url = env("SMTP_URL")?;
        let smtp = match AsyncSmtpTransport::<Tokio1Executor>::from_url(&url) {
            Ok(b) => b.build(),
            Err(e) => {
                eprintln!("SMTP_URL inválida: {e}");
                return None;
            }
        };
        let from = env("MAIL_FROM").unwrap_or_else(|| "PadoSpeak <no-reply@localhost>".into());
        let from = from.parse().map_err(|e| eprintln!("MAIL_FROM inválido: {e}")).ok()?;
        let daily_limit = env("MAIL_DAILY_LIMIT").and_then(|v| v.parse().ok()).unwrap_or(100);
        Some(Self { smtp, from, daily_limit, sent: Mutex::new((0, 0)) })
    }

    /// Conta mais um envio de hoje; `false` quando o teto do dia já foi.
    fn take_quota(&self) -> bool {
        let mut s = self.sent.lock().unwrap();
        let day = today();
        if s.0 != day {
            *s = (day, 0);
        }
        if s.1 >= self.daily_limit {
            return false;
        }
        s.1 += 1;
        true
    }

    pub async fn send(&self, to: &str, subject: &str, text: String) -> Result<(), String> {
        if !self.take_quota() {
            return Err(format!("limite de {} e-mails por dia atingido", self.daily_limit));
        }
        let to: Mailbox = to.parse().map_err(|_| "E-mail inválido".to_string())?;
        let msg = Message::builder()
            .from(self.from.clone())
            .to(to)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN)
            .body(text)
            .map_err(|e| e.to_string())?;
        self.smtp.send(msg).await.map(|_| ()).map_err(|e| e.to_string())
    }
}

/// E-mail com cara de e-mail (o resto o servidor de e-mail confere).
pub fn valid_email(email: &str) -> bool {
    let Some((user, domain)) = email.split_once('@') else { return false };
    email.len() <= 254
        && !user.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !email.chars().any(|c| c.is_whitespace() || c == '<' || c == '>' || c == ',' || c == ';')
        && !domain.contains('@')
}

/// Conta mais um código de confirmação de e-mail para a conta hoje; `false` passado o limite do dia.
fn take_email_code(user_id: &str) -> bool {
    let day = today();
    let mut m = EMAIL_SENDS.lock().unwrap();
    m.retain(|_, (d, _)| *d == day);
    let e = m.entry(user_id.to_string()).or_insert((day, 0));
    if e.1 >= EMAIL_CODES_PER_DAY {
        return false;
    }
    e.1 += 1;
    true
}

fn six_digits() -> String {
    let b = uuid::Uuid::new_v4().as_u128();
    format!("{:06}", b % 1_000_000)
}

// ---------- Google ----------

pub struct Google {
    client_id: String,
    client_secret: String,
    public_url: Option<String>,
    /// Endereços do Google (trocáveis só para testes: `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`).
    auth_url: String,
    token_url: String,
}

impl Google {
    pub fn from_env() -> Option<Self> {
        Some(Self {
            client_id: env("GOOGLE_CLIENT_ID")?,
            client_secret: env("GOOGLE_CLIENT_SECRET")?,
            public_url: env("PUBLIC_URL"),
            auth_url: env("GOOGLE_AUTH_URL").unwrap_or_else(|| "https://accounts.google.com/o/oauth2/v2/auth".into()),
            token_url: env("GOOGLE_TOKEN_URL").unwrap_or_else(|| "https://oauth2.googleapis.com/token".into()),
        })
    }

    /// Endereço de retorno: o `PUBLIC_URL` ou o endereço pelo qual o app chegou aqui.
    fn redirect_uri(&self, headers: &HeaderMap) -> String {
        let base = self.public_url.clone().unwrap_or_else(|| {
            let host = headers.get("host").and_then(|h| h.to_str().ok()).unwrap_or("localhost");
            let local = host.starts_with("localhost") || host.starts_with("127.0.0.1");
            let proto = headers
                .get("x-forwarded-proto")
                .and_then(|h| h.to_str().ok())
                .unwrap_or(if local { "http" } else { "https" });
            format!("{proto}://{host}")
        });
        format!("{}/api/auth/google/callback", base.trim_end_matches('/'))
    }
}

/// O que veio no id_token do Google.
#[derive(Debug, PartialEq)]
pub struct GoogleId {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

/// Lê o id_token recebido direto do Google (pela conexão TLS com o endpoint de token, como o OpenID
/// Connect permite) e confere para quem é, quem emitiu e a validade.
pub fn parse_id_token(token: &str, client_id: &str, now_s: i64) -> Result<GoogleId, String> {
    let payload = token.split('.').nth(1).ok_or("id_token inválido")?;
    let bytes = B64URL.decode(payload.trim_end_matches('=')).map_err(|_| "id_token inválido")?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "id_token inválido")?;
    if v["aud"].as_str() != Some(client_id) {
        return Err("O login do Google é de outro app".into());
    }
    if !matches!(v["iss"].as_str(), Some("https://accounts.google.com" | "accounts.google.com")) {
        return Err("Emissor inválido".into());
    }
    if v["exp"].as_i64().is_none_or(|exp| exp < now_s) {
        return Err("O login do Google expirou".into());
    }
    let sub = v["sub"].as_str().filter(|s| !s.is_empty()).ok_or("Conta Google sem identificador")?.to_string();
    let verified = v["email_verified"].as_bool().unwrap_or(false) || v["email_verified"].as_str() == Some("true");
    let email = v["email"].as_str().filter(|_| verified).map(|e| e.trim().to_lowercase());
    let name = v["name"].as_str().map(str::to_string);
    Ok(GoogleId { sub, email, name })
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Purpose {
    Login,
    Link,
}

/// Um login com o Google em andamento. Quem chama `/begin` recebe o `state`, mas quem volta do Google pode
/// ser outra pessoa (bastaria mandar a ela o endereço da página do Google). Por isso o login só tem efeito
/// quando volta pelo mesmo navegador (cookie `ps_gbind`) ou quando o código mostrado na volta é digitado no
/// app que começou.
struct Pending {
    purpose: Purpose,
    user_id: Option<String>,
    redirect_uri: String,
    created: i64,
    /// Valor do cookie gravado no navegador que começou.
    bind: String,
    /// Quem voltou do Google por outro navegador, ainda sem efeito nenhum, esperando o código no app.
    gid: Option<GoogleId>,
    /// O código mostrado na página de retorno nesse caso.
    confirm: Option<String>,
    attempts: u8,
    result: Option<Value>,
}

static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> = LazyLock::new(Default::default);
/// Último "esqueci a senha" de cada e-mail (um por minuto).
static FORGOT: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);
/// Códigos de confirmação de e-mail mandados hoje por conta: (dia, quantos).
static EMAIL_SENDS: LazyLock<Mutex<HashMap<String, (i64, u32)>>> = LazyLock::new(Default::default);

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/auth/options", get(options))
        .route("/api/auth/forgot", post(forgot))
        .route("/api/auth/google/begin", post(google_begin))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/api/auth/google/poll", get(google_poll))
        .route("/api/me/account", get(account))
        .route("/api/me/email", post(email_start).delete(email_remove))
        .route("/api/me/email/verify", post(email_verify))
        .route("/api/me/google", axum::routing::delete(google_unlink))
}

/// O que este servidor oferece na tela de entrada.
async fn options(State(app): AppState) -> Json<Value> {
    Json(json!({ "email": app.mail.is_some(), "google": app.google.is_some() }))
}

/// Usuário para entrar: pelo nome de usuário ou pelo e-mail confirmado (com @ no meio).
pub async fn find_login(app: &App, ident: &str) -> Result<Option<(User, String, bool)>, ApiError> {
    let ident = ident.trim();
    let by_email = ident.contains('@') && !ident.starts_with('@');
    let sql = format!(
        "SELECT {USER_COLS}, u.password_hash, u.must_reset FROM users u WHERE {}",
        if by_email { "u.email = ?1" } else { "u.username = ?1" }
    );
    let key = if by_email { ident.to_lowercase() } else { ident.trim_start_matches('@').to_string() };
    let n = crate::models::USER_COLS_LEN;
    Ok(app
        .db
        .query_one(&sql, [key.as_str()], |r| Ok((user_from_row(r)?, r.get::<String>(n)?, r.get::<i64>(n + 1)? != 0)))
        .await?)
}

/// O código do "esqueci a senha" confere? (Erro conta tentativa; vencido some.)
pub async fn check_reset_code(app: &App, user_id: &str, code: &str) -> Result<bool, ApiError> {
    let row = app
        .db
        .query_one("SELECT code_hash, expires_at, attempts FROM password_resets WHERE user_id = ?1", [user_id], |r| {
            Ok((r.get::<String>(0)?, r.get::<i64>(1)?, r.get::<i64>(2)?))
        })
        .await?;
    let Some((hash, expires, attempts)) = row else { return Ok(false) };
    if expires < crate::now_ms() || attempts >= CODE_ATTEMPTS {
        app.db.execute("DELETE FROM password_resets WHERE user_id = ?1", [user_id]).await?;
        return Ok(false);
    }
    let code = code.trim().to_uppercase();
    if code.len() == 9 && auth::verify_password(code, hash).await {
        return Ok(true);
    }
    app.db.execute("UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?1", [user_id]).await?;
    Ok(false)
}

pub async fn clear_reset_code(app: &App, user_id: &str) -> Result<(), ApiError> {
    app.db.execute("DELETE FROM password_resets WHERE user_id = ?1", [user_id]).await?;
    Ok(())
}

#[derive(Deserialize)]
struct ForgotBody {
    email: String,
}

/// Esqueci a senha: manda um código para o e-mail da conta (se houver). A resposta é sempre a mesma e sai
/// antes de procurar a conta (o resto roda em segundo plano), para não contar quais e-mails têm conta
/// nem pelo conteúdo nem pelo tempo da resposta.
async fn forgot(State(app): AppState, Json(body): Json<ForgotBody>) -> ApiResult<Json<Value>> {
    if app.mail.is_none() {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Este servidor não manda e-mails"));
    }
    let email = body.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(bad("Digite o e-mail da sua conta"));
    }
    let now = crate::now_ms();
    {
        let mut f = FORGOT.lock().unwrap();
        f.retain(|_, t| now - *t < RESEND_MS);
        if f.contains_key(&email) {
            return Err(bad("Já mandamos um código agora há pouco. Espere um minuto para pedir outro."));
        }
        f.insert(email.clone(), now);
    }
    let app = app.clone();
    tokio::spawn(async move {
        if let Err(e) = send_reset_code(&app, &email).await {
            app.logs.error(format!("e-mail de recuperação para {email}: {e}"));
        }
    });
    Ok(Json(json!({ "ok": true })))
}

/// O trabalho do "esqueci a senha": acha a conta pelo e-mail, guarda o código e manda.
async fn send_reset_code(app: &App, email: &str) -> Result<(), String> {
    let Some(mail) = app.mail.as_ref() else { return Ok(()) };
    let found = app
        .db
        .query_one("SELECT id, username FROM users WHERE email = ?1", [email], |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?)))
        .await
        .map_err(|e| e.to_string())?;
    let Some((id, username)) = found else { return Ok(()) };
    let code = auth::temp_code();
    let hash = auth::hash_password(code.clone()).await;
    app.db
        .execute(
            "INSERT INTO password_resets (user_id, code_hash, expires_at, attempts) VALUES (?1, ?2, ?3, 0) \
             ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0",
            libsql::params![id.as_str(), hash, crate::now_ms() + RESET_CODE_MS],
        )
        .await
        .map_err(|e| e.to_string())?;
    let text = format!(
        "Olá, @{username}!\n\nPara entrar no PadoSpeak sem a senha, use este código no lugar dela:\n\n    {code}\n\n\
         Entre com o seu usuário (ou este e-mail) e o código. Depois o PadoSpeak pede para você criar uma senha nova.\n\
         O código vale por 30 minutos. Se não foi você que pediu, ignore este e-mail: a sua senha continua a mesma.\n"
    );
    mail.send(email, "Código para entrar no PadoSpeak", text).await
}

// ---------- Minha conta ----------

async fn account_of(app: &App, user_id: &str) -> ApiResult<Value> {
    let row = app
        .db
        .query_one("SELECT email, google_sub, password_hash FROM users WHERE id = ?1", [user_id], |r| {
            Ok((r.get::<Option<String>>(0)?, r.get::<Option<String>>(1)?, r.get::<String>(2)?))
        })
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Conta não encontrada"))?;
    let pending = app
        .db
        .query_one("SELECT email FROM email_codes WHERE user_id = ?1 AND expires_at > ?2", libsql::params![user_id, crate::now_ms()], |r| {
            r.get::<String>(0)
        })
        .await?;
    Ok(json!({
        "email": row.0,
        "pendingEmail": pending,
        "google": row.1.is_some(),
        "hasPassword": row.2 != NO_PASSWORD,
        "mail": app.mail.is_some(),
        "googleEnabled": app.google.is_some(),
    }))
}

async fn account(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    Ok(Json(account_of(&app, &me.id).await?))
}

#[derive(Deserialize)]
struct EmailBody {
    email: String,
}

/// Vincular um e-mail: manda um código para ele; o e-mail só vale depois de confirmado.
async fn email_start(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<EmailBody>) -> ApiResult<Json<Value>> {
    let mail = app.mail.as_ref().ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Este servidor não manda e-mails"))?;
    let email = body.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(bad("Digite um e-mail válido"));
    }
    let taken = app.db.query_one("SELECT id FROM users WHERE email = ?1", [email.as_str()], |r| r.get::<String>(0)).await?;
    match taken {
        Some(id) if id == me.id => return Err(bad("Esse já é o e-mail da sua conta")),
        Some(_) => return Err(ApiError::new(StatusCode::CONFLICT, "Esse e-mail já está em outra conta")),
        None => {}
    }
    let now = crate::now_ms();
    let last = app
        .db
        .query_one("SELECT sent_at FROM email_codes WHERE user_id = ?1", [me.id.as_str()], |r| r.get::<i64>(0))
        .await?;
    if last.is_some_and(|t| now - t < RESEND_MS) {
        return Err(bad("Espere um minuto para pedir outro código"));
    }
    if !take_email_code(&me.id) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Você já pediu muitos códigos hoje. Tente de novo amanhã."));
    }
    let code = six_digits();
    let hash = auth::hash_password(code.clone()).await;
    app.db
        .execute(
            "INSERT INTO email_codes (user_id, email, code_hash, expires_at, attempts, sent_at) VALUES (?1, ?2, ?3, ?4, 0, ?5) \
             ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, \
             expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at",
            libsql::params![me.id.as_str(), email.as_str(), hash, now + EMAIL_CODE_MS, now],
        )
        .await?;
    let text = format!(
        "Olá, @{}!\n\nO código para confirmar este e-mail na sua conta do PadoSpeak é:\n\n    {code}\n\n\
         Ele vale por 15 minutos. Com o e-mail confirmado, você pode entrar com ele e receber o código se esquecer a senha.\n\
         Se não foi você, ignore este e-mail.\n",
        me.username
    );
    if let Err(e) = mail.send(&email, &format!("Código do PadoSpeak: {code}"), text).await {
        app.db.execute("DELETE FROM email_codes WHERE user_id = ?1", [me.id.as_str()]).await?;
        app.logs.error(format!("e-mail de confirmação para {email}: {e}"));
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "Não deu para mandar o e-mail agora. Confira o endereço e tente de novo."));
    }
    Ok(Json(account_of(&app, &me.id).await?))
}

#[derive(Deserialize)]
struct CodeBody {
    code: String,
}

async fn email_verify(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<CodeBody>) -> ApiResult<Json<Value>> {
    let row = app
        .db
        .query_one("SELECT email, code_hash, expires_at, attempts FROM email_codes WHERE user_id = ?1", [me.id.as_str()], |r| {
            Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<i64>(2)?, r.get::<i64>(3)?))
        })
        .await?;
    let Some((email, hash, expires, attempts)) = row else {
        return Err(bad("Peça um código primeiro"));
    };
    if expires < crate::now_ms() || attempts >= CODE_ATTEMPTS {
        app.db.execute("DELETE FROM email_codes WHERE user_id = ?1", [me.id.as_str()]).await?;
        return Err(bad("O código venceu. Peça outro."));
    }
    let code: String = body.code.chars().filter(char::is_ascii_digit).collect();
    if code.len() != 6 || !auth::verify_password(code, hash).await {
        app.db.execute("UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?1", [me.id.as_str()]).await?;
        return Err(bad("Código incorreto"));
    }
    let taken = app
        .db
        .query_one("SELECT 1 FROM users WHERE email = ?1 AND id <> ?2", [email.as_str(), me.id.as_str()], |_| Ok(()))
        .await?;
    if taken.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Esse e-mail já está em outra conta"));
    }
    app.db.execute("UPDATE users SET email = ?1 WHERE id = ?2", [email.as_str(), me.id.as_str()]).await?;
    app.db.execute("DELETE FROM email_codes WHERE user_id = ?1", [me.id.as_str()]).await?;
    Ok(Json(account_of(&app, &me.id).await?))
}

async fn email_remove(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let acc = account_of(&app, &me.id).await?;
    if !acc["hasPassword"].as_bool().unwrap_or(false) && !acc["google"].as_bool().unwrap_or(false) {
        return Err(bad("Sem o e-mail você não teria como entrar: crie uma senha antes"));
    }
    app.db.execute("UPDATE users SET email = NULL WHERE id = ?1", [me.id.as_str()]).await?;
    app.db.execute("DELETE FROM email_codes WHERE user_id = ?1", [me.id.as_str()]).await?;
    Ok(Json(account_of(&app, &me.id).await?))
}

async fn google_unlink(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let acc = account_of(&app, &me.id).await?;
    if !acc["hasPassword"].as_bool().unwrap_or(false) && acc["email"].is_null() {
        return Err(bad("Sem o Google você não teria como entrar: vincule um e-mail antes"));
    }
    app.db.execute("UPDATE users SET google_sub = NULL WHERE id = ?1", [me.id.as_str()]).await?;
    Ok(Json(account_of(&app, &me.id).await?))
}

// ---------- Google ----------

#[derive(Deserialize)]
struct BeginBody {
    #[serde(default)]
    purpose: String,
}

/// Começa o login (ou o vínculo) com o Google: devolve o endereço da página do Google para abrir e grava
/// no navegador que pediu um cookie que liga a volta do Google a ele.
async fn google_begin(State(app): AppState, headers: HeaderMap, Json(body): Json<BeginBody>) -> ApiResult<Response> {
    let google = app.google.as_ref().ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Este servidor não tem login com o Google"))?;
    let purpose = if body.purpose == "link" { Purpose::Link } else { Purpose::Login };
    let user_id = if purpose == Purpose::Link {
        let token = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or_default();
        Some(auth::user_from_token(&app.db, token).await.ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Entre na conta primeiro"))?.id)
    } else {
        None
    };
    let state = auth::random_token();
    let bind = auth::random_token();
    let redirect_uri = google.redirect_uri(&headers);
    let now = crate::now_ms();
    {
        let mut p = PENDING.lock().unwrap();
        p.retain(|_, v| now - v.created < OAUTH_TTL_MS);
        p.insert(
            state.clone(),
            Pending {
                purpose,
                user_id,
                redirect_uri: redirect_uri.clone(),
                created: now,
                bind: bind.clone(),
                gid: None,
                confirm: None,
                attempts: 0,
                result: None,
            },
        );
    }
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&prompt=select_account",
        google.auth_url,
        url_encode(&google.client_id),
        url_encode(&redirect_uri),
        url_encode("openid email profile"),
        state
    );
    let secure = if redirect_uri.starts_with("https://") { "; Secure" } else { "" };
    let cookie = format!("{BIND_COOKIE}={bind}; Path=/api/auth/google; Max-Age={}; HttpOnly; SameSite=Lax{secure}", OAUTH_TTL_MS / 1000);
    Ok(([(axum::http::header::SET_COOKIE, cookie)], Json(json!({ "url": url, "state": state }))).into_response())
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

/// Código curto mostrado na volta do Google quando ela vem por outro navegador (sem letras que confundem).
fn confirm_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    uuid::Uuid::new_v4().as_bytes().iter().take(6).map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

fn normalize_code(code: &str) -> String {
    code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn page_html(title: &str, color: &str, body: &str, close: bool) -> Response {
    let close = if close { "<script>setTimeout(function(){window.close()},1500)</script>" } else { "" };
    Html(format!(
        r#"<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PadoSpeak</title><style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 "Segoe UI",system-ui,sans-serif;color:#10324d;
background:linear-gradient(180deg,#0d6cc0 0%,#3ea3e6 55%,#92d8f7 100%)}}
.c{{background:rgba(255,255,255,.94);border:1px solid #fff;border-radius:14px;padding:24px 28px;max-width:360px;margin:16px;text-align:center;box-shadow:0 10px 30px rgba(10,70,120,.25)}}
b{{display:block;font-size:20px;color:{color};margin-bottom:6px}}
.code{{font:800 34px/1.2 ui-monospace,Consolas,monospace;letter-spacing:6px;margin:14px 0;color:#10324d;user-select:all}}
small{{display:block;color:#5a6b7a;margin-top:10px}}</style></head>
<body><div class="c"><b>{title}</b>{body}</div>{close}</body></html>"#
    ))
    .into_response()
}

fn page(ok: bool, msg: &str) -> Response {
    let (title, color) = if ok { ("Pronto!", "#3c9c15") } else { ("Não deu certo", "#c8321c") };
    page_html(title, color, msg, true)
}

/// Volta do Google pelo outro navegador: mostra o código para digitar no app.
fn confirm_page(code: &str) -> Response {
    page_html(
        "Quase lá!",
        "#0d6cc0",
        &format!(
            "Digite este código no PadoSpeak para terminar:<div class=\"code\">{code}</div>\
             <small>Digite só no PadoSpeak que você mesmo abriu. Não passe este código para ninguém: com ele, \
             outra pessoa entraria na sua conta.</small>"
        ),
        false,
    )
}

/// Guarda o resultado para o app buscar e mostra a página do fim.
fn finish_page(state: &str, purpose: Purpose, result: Result<Value, String>) -> Response {
    let (value, response) = match result {
        Ok(v) => (
            v,
            page(true, if purpose == Purpose::Link { "A conta Google foi vinculada. Pode voltar para o PadoSpeak." } else { "Pode voltar para o PadoSpeak." }),
        ),
        Err(e) => {
            let response = page(false, &format!("{e} Volte para o PadoSpeak."));
            (json!({ "error": e }), response)
        }
    };
    if let Some(p) = PENDING.lock().unwrap().get_mut(state) {
        p.result = Some(value);
    }
    response
}

/// Volta do Google: troca o código pela identidade. Pelo mesmo navegador que começou, termina o login aqui;
/// por outro, guarda a identidade sem efeito nenhum e mostra o código que o app precisa digitar.
async fn google_callback(State(app): AppState, headers: HeaderMap, Query(q): Query<CallbackQuery>) -> Response {
    let Some(google) = app.google.as_ref() else { return page(false, "Este servidor não tem login com o Google.") };
    let state = q.state.unwrap_or_default();
    let pending = PENDING
        .lock()
        .unwrap()
        .get(&state)
        .filter(|p| p.gid.is_none() && p.result.is_none())
        .map(|p| (p.purpose, p.user_id.clone(), p.redirect_uri.clone(), p.bind.clone()));
    let Some((purpose, user_id, redirect_uri, bind)) = pending else {
        return page(false, "Este login expirou. Volte para o PadoSpeak e tente de novo.");
    };
    let gid = match (q.error, q.code) {
        (Some(_), _) | (None, None) => Err("O login com o Google foi cancelado.".to_string()),
        (None, Some(code)) => exchange_code(google, &code, &redirect_uri).await,
    };
    let gid = match gid {
        Ok(g) => g,
        Err(e) => return finish_page(&state, purpose, Err(e)),
    };
    if cookie(&headers, BIND_COOKIE).is_some_and(|c| c == bind) {
        let result = apply_google(&app, purpose, user_id, &gid).await;
        return finish_page(&state, purpose, result);
    }
    let code = confirm_code();
    if let Some(p) = PENDING.lock().unwrap().get_mut(&state) {
        p.gid = Some(gid);
        p.confirm = Some(code.clone());
    }
    confirm_page(&code)
}

/// Troca o código da volta do Google pelo id_token e lê quem é.
async fn exchange_code(google: &Google, code: &str, redirect_uri: &str) -> Result<GoogleId, String> {
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let form = [
        ("code", code),
        ("client_id", google.client_id.as_str()),
        ("client_secret", google.client_secret.as_str()),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    let body = form.iter().map(|(k, v)| format!("{k}={}", url_encode(v))).collect::<Vec<_>>().join("&");
    let res = http
        .post(&google.token_url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Sem resposta do Google: {e}"))?;
    let bytes = res.bytes().await.map_err(|_| "Resposta inválida do Google".to_string())?;
    let tok: Value = serde_json::from_slice(&bytes).map_err(|_| "Resposta inválida do Google".to_string())?;
    let id_token = tok["id_token"].as_str().ok_or_else(|| format!("O Google recusou o login ({}).", tok["error"].as_str().unwrap_or("sem id_token")))?;
    parse_id_token(id_token, &google.client_id, crate::now_ms() / 1000)
}

/// O efeito do login confirmado: vincula o Google, ou acha/cria a conta e abre a sessão.
async fn apply_google(app: &App, purpose: Purpose, user_id: Option<String>, gid: &GoogleId) -> Result<Value, String> {
    let db_err = |e: libsql::Error| e.to_string();
    match purpose {
        Purpose::Link => {
            let me = user_id.ok_or("Entre na conta primeiro")?;
            let other = app
                .db
                .query_one("SELECT id FROM users WHERE google_sub = ?1", [gid.sub.as_str()], |r| r.get::<String>(0))
                .await
                .map_err(db_err)?;
            if other.as_ref().is_some_and(|o| *o != me) {
                return Err("Essa conta Google já está ligada a outro usuário.".into());
            }
            app.db.execute("UPDATE users SET google_sub = ?1 WHERE id = ?2", [gid.sub.as_str(), me.as_str()]).await.map_err(db_err)?;
            // Sem e-mail ainda: o do Google (já confirmado por ele) vira o e-mail da conta.
            if let Some(email) = &gid.email {
                let _ = app
                    .db
                    .execute(
                        "UPDATE users SET email = ?1 WHERE id = ?2 AND email IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?1)",
                        [email.as_str(), me.as_str()],
                    )
                    .await;
            }
            Ok(json!({ "linked": true }))
        }
        Purpose::Login => {
            let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.google_sub = ?1");
            let mut user = app.db.query_one(&sql, [gid.sub.as_str()], user_from_row).await.map_err(db_err)?;
            if user.is_none() {
                if let Some(email) = &gid.email {
                    let sql = format!("SELECT {USER_COLS} FROM users u WHERE u.email = ?1");
                    user = app.db.query_one(&sql, [email.as_str()], user_from_row).await.map_err(db_err)?;
                    if let Some(u) = &user {
                        app.db.execute("UPDATE users SET google_sub = ?1 WHERE id = ?2", [gid.sub.as_str(), u.id.as_str()]).await.map_err(db_err)?;
                    }
                }
            }
            let (user, created) = match user {
                Some(u) => (u, false),
                None => (create_google_user(app, &gid).await?, true),
            };
            let token = auth::create_session(&app.db, &user.id).await.map_err(db_err)?;
            Ok(json!({ "token": token, "user": user, "created": created }))
        }
    }
}

/// Nome de usuário a partir do e-mail (ou do nome) do Google, sem repetir um que já existe.
fn username_base(gid: &GoogleId) -> String {
    let source = gid.email.as_deref().and_then(|e| e.split('@').next()).or(gid.name.as_deref()).unwrap_or("usuario");
    let mut base: String = source
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim_matches(|c| c == '_' || c == '.')
        .chars()
        .take(20)
        .collect();
    if base.len() < 3 || base == "everyone" {
        base = format!("{base}user").trim_start_matches('_').to_string();
    }
    base
}

async fn create_google_user(app: &App, gid: &GoogleId) -> Result<User, String> {
    if !app.config.allow_registration {
        return Err("Não há conta com esse Google neste servidor, e o cadastro está desativado.".into());
    }
    let base = username_base(gid);
    let mut username = base.clone();
    for n in 2..1000 {
        let taken = app
            .db
            .query_one("SELECT 1 FROM users WHERE username = ?1", [username.as_str()], |_| Ok(()))
            .await
            .map_err(|e| e.to_string())?;
        if taken.is_none() {
            break;
        }
        username = format!("{}{n}", &base[..base.len().min(21)]);
    }
    let display_name = gid
        .name
        .as_deref()
        .and_then(|d| crate::models::fit_formatted(d, crate::models::NAME_MAX, crate::models::NAME_RAW_MAX))
        .filter(|d| crate::models::visible_len(d) > 0)
        .unwrap_or_else(|| username.clone());
    let user = User {
        id: uuid::Uuid::new_v4().simple().to_string(),
        username,
        display_name,
        avatar_color: crate::api::random_color(),
        avatar_url: None,
        bio: String::new(),
        name_color: None,
        bio_color: None,
        banner_color: None,
        lan: false,
        message_color: None,
    };
    app.db
        .execute(
            "INSERT INTO users (id, username, display_name, password_hash, avatar_color, created_at, email, google_sub) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            libsql::params![
                user.id.as_str(),
                user.username.as_str(),
                user.display_name.as_str(),
                NO_PASSWORD,
                user.avatar_color.as_str(),
                crate::now_ms(),
                gid.email.clone(),
                gid.sub.as_str()
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(user)
}

#[derive(Deserialize)]
struct PollQuery {
    state: String,
    /// O código que a página de retorno mostrou, quando ela abriu em outro navegador.
    #[serde(default)]
    code: Option<String>,
}

enum PollNext {
    Wait { need_code: bool },
    Done(Value),
    Apply(Purpose, Option<String>, GoogleId),
    Wrong,
    Fail(&'static str),
}

fn poll_response(result: Value) -> Response {
    if result["error"].is_string() {
        return (StatusCode::BAD_REQUEST, Json(result)).into_response();
    }
    Json(result).into_response()
}

/// O app pergunta se o login com o Google terminou (202 enquanto a pessoa está na página do Google). Se a
/// volta foi por outro navegador, o 202 traz `needCode` e o login só termina com o código certo.
async fn google_poll(State(app): AppState, Query(q): Query<PollQuery>) -> Response {
    let next = {
        let mut p = PENDING.lock().unwrap();
        let Some(entry) = p.get_mut(&q.state) else {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "Este login expirou. Tente de novo." }))).into_response();
        };
        if entry.result.is_some() {
            PollNext::Done(p.remove(&q.state).and_then(|e| e.result).unwrap_or(Value::Null))
        } else if let Some(confirm) = entry.confirm.clone() {
            match q.code.as_deref().map(normalize_code) {
                None => PollNext::Wait { need_code: true },
                Some(code) if code == confirm => match p.remove(&q.state) {
                    Some(Pending { purpose, user_id, gid: Some(gid), .. }) => PollNext::Apply(purpose, user_id, gid),
                    _ => PollNext::Fail("Este login expirou. Tente de novo."),
                },
                Some(_) => {
                    entry.attempts += 1;
                    if entry.attempts >= CONFIRM_ATTEMPTS {
                        p.remove(&q.state);
                        PollNext::Fail("Código errado vezes demais. Comece o login de novo.")
                    } else {
                        PollNext::Wrong
                    }
                }
            }
        } else {
            PollNext::Wait { need_code: false }
        }
    };
    match next {
        PollNext::Wait { need_code } => (StatusCode::ACCEPTED, Json(json!({ "pending": true, "needCode": need_code }))).into_response(),
        PollNext::Done(result) => poll_response(result),
        PollNext::Apply(purpose, user_id, gid) => {
            poll_response(apply_google(&app, purpose, user_id, &gid).await.unwrap_or_else(|e| json!({ "error": e })))
        }
        PollNext::Wrong => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": "Código incorreto. Confira o que aparece no navegador.", "retry": true }))).into_response()
        }
        PollNext::Fail(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(payload: Value) -> String {
        format!("eyJhbGciOiJSUzI1NiJ9.{}.assinatura", B64URL.encode(payload.to_string()))
    }

    #[test]
    fn le_o_id_token_do_google() {
        let ok = json!({ "iss": "https://accounts.google.com", "aud": "app.apps.googleusercontent.com", "sub": "123", "email": "Ana@Gmail.com", "email_verified": true, "name": "Ana Lima", "exp": 2000 });
        let id = parse_id_token(&token(ok.clone()), "app.apps.googleusercontent.com", 1000).unwrap();
        assert_eq!(id, GoogleId { sub: "123".into(), email: Some("ana@gmail.com".into()), name: Some("Ana Lima".into()) });
        // Outro app, vencido, e-mail sem confirmação.
        assert!(parse_id_token(&token(ok.clone()), "outro", 1000).is_err());
        assert!(parse_id_token(&token(ok.clone()), "app.apps.googleusercontent.com", 3000).is_err());
        let mut unverified = ok.clone();
        unverified["email_verified"] = json!(false);
        assert_eq!(parse_id_token(&token(unverified), "app.apps.googleusercontent.com", 1000).unwrap().email, None);
    }

    #[test]
    fn email_e_nome_de_usuario() {
        assert!(valid_email("ana.lima@gmail.com"));
        assert!(!valid_email("ana@gmail"));
        assert!(!valid_email("ana gmail.com"));
        assert!(!valid_email("a@b@c.com"));
        assert!(!valid_email("ana@.com"));
        let g = |email: &str| GoogleId { sub: "1".into(), email: Some(email.into()), name: None };
        assert_eq!(username_base(&g("Ana.Lima+x@gmail.com")), "ana.lima_x");
        assert_eq!(username_base(&g("jo@x.com")), "jouser");
        assert_eq!(six_digits().len(), 6);
    }

    #[test]
    fn codigo_e_cookie_do_login_com_o_google() {
        let c = confirm_code();
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|ch| "ABCDEFGHJKMNPQRSTUVWXYZ23456789".contains(ch)));
        assert_eq!(normalize_code(" ab-c 12 3"), "ABC123");
        let mut h = HeaderMap::new();
        h.insert("cookie", "outro=1; ps_gbind=abc; x=y".parse().unwrap());
        assert_eq!(cookie(&h, BIND_COOKIE).as_deref(), Some("abc"));
        assert_eq!(cookie(&h, "nada"), None);
    }

    #[test]
    fn limite_de_codigos_de_email_por_dia() {
        let id = format!("teste-{}", uuid::Uuid::new_v4());
        for _ in 0..EMAIL_CODES_PER_DAY {
            assert!(take_email_code(&id));
        }
        assert!(!take_email_code(&id));
    }
}
