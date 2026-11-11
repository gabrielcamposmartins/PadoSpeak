//! Nó de mídia: o SFU das chamadas e o token (e a busca) da música, no próprio servidor (embutido) ou em
//! outra máquina (`padospeak-server media`, ou o app do Windows) ligada a ele pelo canal de controle.
//!
//! - `registry`: o lado do servidor principal (quem está de pé, a carga, a ponte para os comandos).
//! - `control`: o pareamento e o formato das mensagens do canal de controle.
//! - `node`: o processo do nó (liga para o principal, roda o SFU, o provedor de token e a busca da música).
//! - `sfu`: o SFU (veio do HardLine).
//! - `pot`: o provedor de token do YouTube (bgutil) que o nó supervisiona.
//! - `relay`: a música buscada pelo nó, entregue aos apps pelo principal.
//! - `load`: a carga do principal.
//!
//! A sala de voz vai para o SFU quando há gente suficiente e um nó de pé (`Hub::media_changed`); se o nó
//! cair, os apps passam a voz para a malha de reserva sozinhos, sem esperar o servidor
//! (`client/src/lib/voice.js`).
pub mod control;
pub mod load;
pub mod node;
pub mod pot;
pub mod registry;
pub mod relay;
pub mod sfu;

use crate::api::{ApiError, AuthUser};
use crate::host::App;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use registry::{MediaSettings, Registry, LOCAL, SETTINGS_KEY};
use serde::Deserialize;
use serde_json::{json, Value};
use sfu::{PubTrack, Sfu, SfuConfig, Want};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/* ---------------------------------------------------------- comandos do SFU em JSON */

/// Aplica um comando do SFU (o mesmo formato vale para o embutido e para o canal de controle).
pub fn apply_cmd(sfu: &Sfu, op: &str, d: &Value) {
    let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default();
    let conn = s("conn");
    match op {
        "join" if !conn.is_empty() => sfu.join(conn, s("room")),
        "answer" if !conn.is_empty() => {
            if let Some(answer) = d.get("sdp").cloned().and_then(|v| serde_json::from_value(v).ok()) {
                sfu.answer(conn, answer);
            }
        }
        "want" if !conn.is_empty() => {
            let wants: HashMap<String, Want> = d.get("peers").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
            sfu.want(conn, wants.into_iter().take(200).collect());
        }
        "leave" if !conn.is_empty() => sfu.leave(conn),
        "rekey" if !s("old").is_empty() && !s("new").is_empty() => sfu.rekey(s("old"), s("new")),
        "keyframe" if !conn.is_empty() => sfu.keyframe(conn, s("from")),
        _ => {}
    }
}

/// Oferta da conexão de envio → `{ sdp }` (a resposta do SFU) ou `{ error }`.
pub async fn publish(sfu: &Sfu, d: &Value) -> Value {
    let conn = d.get("conn").and_then(Value::as_str).unwrap_or_default();
    let Some(offer) = d.get("sdp").cloned().and_then(|v| serde_json::from_value(v).ok()) else {
        return json!({ "error": "Oferta inválida" });
    };
    let tracks: Vec<PubTrack> = d.get("tracks").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    match sfu.publish(conn, offer, tracks.into_iter().take(8).collect()).await {
        Ok(answer) => json!({ "sdp": answer }),
        Err(e) => json!({ "error": e }),
    }
}

/* ---------------------------------------------------------- no servidor principal */

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/media/control", get(control_ws))
        .route("/api/media/stream/{ticket}", get(relay::stream_ws))
        .route("/api/admin/media", get(admin_view).put(admin_save))
        .route("/api/admin/media/nodes", post(admin_add))
        .route("/api/admin/media/nodes/{id}", patch(admin_edit).delete(admin_remove))
        .route("/api/admin/media/nodes/{id}/code", post(admin_new_code))
}

/// Ajustes guardados (Painel → Mídia).
pub async fn load_settings(app: &App) -> MediaSettings {
    app.db
        .get_setting(SETTINGS_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

/// A prioridade e o modo do SFU de cada nó (do banco para o registro).
async fn load_priorities(app: &App) {
    let rows = app
        .db
        .query_all("SELECT id, priority, sfu_mode FROM media_nodes", (), |r| Ok((r.get::<String>(0)?, r.get::<i64>(1)?, r.get::<String>(2)?)))
        .await
        .unwrap_or_default();
    app.media.set_priorities(rows.iter().map(|(id, p, _)| (id.clone(), *p)).collect());
    app.media.set_modes(rows.into_iter().map(|(id, _, m)| (id, registry::SfuMode::parse(&m))).collect());
}

/// Liga o que o servidor principal faz pelos nós: a carga, o SFU embutido (se escolhido), o provedor de
/// token para o yt-dlp e a revisão periódica das salas.
pub async fn start(app: &Arc<App>) {
    app.media.set_settings(load_settings(app).await);
    load_priorities(app).await;
    app.media.load.spawn(app.hub.shutdown.clone());
    if let Err(e) = crate::music::pot::start_shim(app.clone()).await {
        app.logs.warn(format!("Token da música: o provedor local não abriu ({e})"));
    }
    let app = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = app.hub.shutdown.cancelled() => break,
            }
            ensure_local(&app);
            crate::music::pot::refresh(&app.media);
            app.hub.media_changed();
        }
        app.media.set_local(None);
    });
}

/// Sobe (ou desliga) o SFU embutido conforme o painel ou `SFU_EMBEDDED`.
fn ensure_local(app: &Arc<App>) {
    let want = app.media.wants_local() && app.lan.is_none();
    let have = app.media.local().is_some();
    if want == have {
        return;
    }
    if !want {
        app.media.set_local(None);
        app.logs.info("Mídia: SFU deste servidor desligado");
        return;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    match Sfu::start(SfuConfig::from_env(), tx, &app.hub.shutdown) {
        Ok(sfu) => {
            app.logs.info(format!("Mídia: SFU deste servidor na porta UDP {}", sfu.port));
            app.media.set_local(Some(sfu));
            let hub = app.hub.clone();
            tokio::spawn(async move {
                while let Some((conn, msg)) = rx.recv().await {
                    hub.send_raw(&conn, registry::tag_node(&msg, LOCAL));
                }
            });
        }
        Err(e) => {
            // Porta ocupada (ou sem permissão): tenta de novo na próxima volta, sem encher o registro.
            static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                app.logs.error(format!("Mídia: o SFU deste servidor não subiu ({e})"));
            }
        }
    }
}

/* ---------------------------------------------------------- canal de controle */

async fn control_ws(ws: WebSocketUpgrade, State(app): AppState, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if app.lan.is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let ip = crate::hub::client_ip(addr, &headers).to_canonical().to_string();
    ws.max_message_size(2 << 20).on_upgrade(move |socket| run_control(app, socket, ip))
}

struct NodeRow {
    name: String,
    secret: String,
    enabled: bool,
}

async fn node_row(app: &App, id: &str) -> Option<NodeRow> {
    app.db
        .query_one("SELECT name, secret, enabled FROM media_nodes WHERE id = ?1", [id], |r| {
            Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<i64>(2)?))
        })
        .await
        .ok()
        .flatten()
        .map(|(name, secret, enabled)| NodeRow { name, secret: app.db.cipher.reveal(&secret), enabled: enabled != 0 })
}

async fn run_control(app: Arc<App>, socket: WebSocket, ip: String) {
    let (mut sink, mut stream) = socket.split();
    let refuse = |error: &str| WsMessage::Text(json!({ "t": "refused", "error": error }).to_string().into());
    // O `hello` vem primeiro, logo.
    let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await;
    let Ok(Some(Ok(WsMessage::Text(text)))) = first else { return };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return };
    let Ok(hello) = serde_json::from_value::<control::Hello>(v.clone()) else {
        let _ = sink.send(refuse("Pedido inválido")).await;
        return;
    };
    let Some(row) = node_row(&app, &hello.id).await else {
        let _ = sink.send(refuse("Este nó não está cadastrado (foi removido do painel?)")).await;
        return;
    };
    if !row.enabled {
        let _ = sink.send(refuse("Este nó está desativado no painel")).await;
        return;
    }
    if let Err(e) = control::verify(&row.secret, &hello.id, hello.ts, &hello.nonce, &hello.mac, crate::now_ms()) {
        app.logs.warn(format!("Mídia: nó {} recusado de {ip}: {e}", row.name));
        let _ = sink.send(refuse(e)).await;
        return;
    }
    if !app.media.fresh_nonce(&hello.nonce) {
        let _ = sink.send(refuse("Pedido repetido")).await;
        return;
    }
    let welcome = json!({ "t": "welcome", "publicIp": ip, "bootId": app.hub.boot_id(), "name": row.name });
    if sink.send(WsMessage::Text(welcome.to_string().into())).await.is_err() {
        return;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let session = app.media.attach(&hello, &row.name, &ip, tx);
    app.logs.info(format!("Mídia: nó \"{}\" ligado de {ip} ({})", row.name, hello.caps.join(", ")));
    let _ = app.db.execute("UPDATE media_nodes SET last_seen = ?1 WHERE id = ?2", libsql::params![crate::now_ms(), hello.id.as_str()]).await;

    let stop = CancellationToken::new();
    let writer = {
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut beat = tokio::time::interval(control::BEAT_EVERY);
            loop {
                tokio::select! {
                    msg = rx.recv() => match msg {
                        Some(text) => if sink.send(WsMessage::Text(text.into())).await.is_err() { break },
                        None => break,
                    },
                    _ = beat.tick() => {
                        if sink.send(WsMessage::Text(r#"{"t":"beat"}"#.into())).await.is_err() { break }
                    }
                    _ = stop.cancelled() => break,
                }
            }
            let _ = sink.send(WsMessage::Close(None)).await;
        })
    };
    let id = hello.id.clone();
    let mut watchdog = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(WsMessage::Text(text))) => on_node_message(&app, &id, session, &text),
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = watchdog.tick() => {
                if app.media.stale(&id, session) || writer.is_finished() {
                    break;
                }
            }
            _ = app.hub.shutdown.cancelled() => break,
        }
    }
    stop.cancel();
    if app.media.detach(&id, session) {
        app.logs.warn(format!("Mídia: nó \"{}\" desligou", row.name));
        // As salas dele vão para a malha agora (os apps já perceberam pelo batimento do SFU).
        app.hub.media_changed();
    }
    let _ = app.db.execute("UPDATE media_nodes SET last_seen = ?1 WHERE id = ?2", libsql::params![crate::now_ms(), id.as_str()]).await;
}

fn on_node_message(app: &App, id: &str, session: u64, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    match v.get("t").and_then(Value::as_str) {
        Some("beat") => app.media.beat(id, session, v.get("load").cloned().unwrap_or(Value::Null)),
        Some("res") => {
            if let Some(req) = v.get("id").and_then(Value::as_u64) {
                app.media.respond(id, req, v.get("d").cloned().unwrap_or(Value::Null));
            }
        }
        Some("ev") => {
            let (Some(conn), Some(msg)) = (v.get("conn").and_then(Value::as_str), v.get("msg").and_then(Value::as_str)) else { return };
            app.hub.send_raw(conn, registry::tag_node(msg, id));
        }
        _ => {}
    }
}

/* ---------------------------------------------------------- painel */

async fn rights(app: &App, me: &crate::models::User) -> ApiResult<bool> {
    let (view, owner) = crate::admin::rights(app, me).await?;
    if !view {
        return Err(ApiError(StatusCode::NOT_FOUND, "Não encontrado".into()));
    }
    Ok(owner)
}

fn forbidden() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "Só o dono do app muda os nós de mídia".into())
}

async fn admin_view(State(app): AppState, AuthUser(me, _): AuthUser) -> ApiResult<Json<Value>> {
    let owner = rights(&app, &me).await?;
    Ok(Json(view(&app, owner).await?))
}

async fn view(app: &App, owner: bool) -> ApiResult<Value> {
    let rows = app
        .db
        .query_all("SELECT id, name, priority, enabled, created_at, last_seen, sfu_mode FROM media_nodes ORDER BY priority, created_at", (), |r| {
            Ok((
                r.get::<String>(0)?,
                r.get::<String>(1)?,
                r.get::<i64>(2)?,
                r.get::<i64>(3)?,
                r.get::<i64>(4)?,
                r.get::<Option<i64>>(5)?,
                r.get::<String>(6)?,
            ))
        })
        .await?;
    let live = app.media.live();
    let nodes: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, priority, enabled, created_at, last_seen, sfu_mode)| {
            let mut v = json!({
                "id": id, "name": name, "priority": priority, "enabled": enabled != 0,
                "sfuMode": registry::SfuMode::parse(&sfu_mode).as_str(),
                "createdAt": created_at, "lastSeen": last_seen, "online": false,
            });
            if let (Some(l), Some(obj)) = (live.get(&id), v.as_object_mut()) {
                for (k, val) in l.as_object().into_iter().flatten() {
                    if k != "name" {
                        obj.insert(k.clone(), val.clone());
                    }
                }
            }
            v
        })
        .collect();
    Ok(json!({
        "canEdit": owner,
        "settings": app.media.settings(),
        "locked": { "embeddedSfu": Registry::env_embedded().is_some() },
        "embeddedSfu": app.media.wants_local(),
        "local": app.media.local_view(),
        "load": app.media.load.now(),
        "rooms": app.hub.media_rooms(),
        "potReady": crate::music::pot::available(),
        "nodes": nodes,
    }))
}

async fn admin_save(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<MediaSettings>) -> ApiResult<Json<Value>> {
    if !rights(&app, &me).await? {
        return Err(forbidden());
    }
    let settings = body.normalized();
    app.db.set_setting(SETTINGS_KEY, &serde_json::to_string(&settings).unwrap_or_default()).await?;
    app.media.set_settings(settings);
    app.logs.info(format!("Mídia: ajustes salvos por {}", me.username));
    ensure_local(&app);
    app.hub.media_changed();
    Ok(Json(view(&app, true).await?))
}

#[derive(Deserialize)]
struct NewNode {
    name: String,
    /// Endereço do servidor como o painel o vê (`location.origin`): vai no código para o nó ligar.
    url: String,
}

fn clean_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect()
}

fn pairing_url(url: &str) -> ApiResult<String> {
    let url = url.trim().trim_end_matches('/');
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.len() > 200 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Endereço do servidor inválido".into()));
    }
    // `PUBLIC_URL` (o endereço oficial) vale mais que o do navegador, que pode ser um IP da rede.
    Ok(std::env::var("PUBLIC_URL").ok().map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| url.to_string()))
}

/// Cadastra um nó e devolve (id, código de pareamento). O código leva o segredo: só aparece uma vez.
pub async fn create_node(db: &crate::db::Db, name: &str, url: String) -> Result<(String, String), libsql::Error> {
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let secret = control::new_secret();
    let next = db.query_one("SELECT COALESCE(MAX(priority), -1) + 1 FROM media_nodes", (), |r| r.get::<i64>(0)).await?.unwrap_or(0);
    db.execute(
        "INSERT INTO media_nodes (id, name, secret, priority, enabled, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        libsql::params![id.as_str(), name, db.cipher.seal(&secret), next, crate::now_ms()],
    )
    .await?;
    let code = control::Pairing { url, id: id.clone(), secret }.encode();
    Ok((id, code))
}

async fn admin_add(State(app): AppState, AuthUser(me, _): AuthUser, Json(body): Json<NewNode>) -> ApiResult<Json<Value>> {
    if !rights(&app, &me).await? {
        return Err(forbidden());
    }
    let name = clean_name(&body.name);
    if name.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Dê um nome ao nó".into()));
    }
    let url = pairing_url(&body.url)?;
    let (id, code) = create_node(&app.db, &name, url).await?;
    load_priorities(&app).await;
    app.logs.info(format!("Mídia: nó \"{name}\" criado por {}", me.username));
    Ok(Json(json!({ "id": id, "code": code, "view": view(&app, true).await? })))
}

async fn admin_new_code(
    State(app): AppState,
    AuthUser(me, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    if !rights(&app, &me).await? {
        return Err(forbidden());
    }
    let url = pairing_url(body.get("url").and_then(Value::as_str).unwrap_or_default())?;
    let secret = control::new_secret();
    let n = app.db.execute("UPDATE media_nodes SET secret = ?1 WHERE id = ?2", [app.db.cipher.seal(&secret), id.clone()]).await?;
    if n == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Nó não encontrado".into()));
    }
    // O código antigo deixa de valer: quem estava ligado com ele cai.
    app.media.kick(&id);
    app.hub.media_changed();
    let code = control::Pairing { url, id: id.clone(), secret }.encode();
    Ok(Json(json!({ "id": id, "code": code })))
}

#[derive(Deserialize)]
struct EditNode {
    name: Option<String>,
    priority: Option<i64>,
    enabled: Option<bool>,
    /// `all`, `voice` ou `off` (veja `registry::SfuMode`).
    #[serde(rename = "sfuMode")]
    sfu_mode: Option<String>,
}

async fn admin_edit(
    State(app): AppState,
    AuthUser(me, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<EditNode>,
) -> ApiResult<Json<Value>> {
    if !rights(&app, &me).await? {
        return Err(forbidden());
    }
    if let Some(name) = body.name.as_deref().map(clean_name).filter(|n| !n.is_empty()) {
        app.db.execute("UPDATE media_nodes SET name = ?1 WHERE id = ?2", [name, id.clone()]).await?;
    }
    if let Some(p) = body.priority {
        app.db.execute("UPDATE media_nodes SET priority = ?1 WHERE id = ?2", libsql::params![p.clamp(0, 1000), id.as_str()]).await?;
    }
    if let Some(on) = body.enabled {
        app.db.execute("UPDATE media_nodes SET enabled = ?1 WHERE id = ?2", libsql::params![on as i64, id.as_str()]).await?;
        if !on {
            app.media.kick(&id);
        }
    }
    if let Some(m) = body.sfu_mode.as_deref() {
        let mode = registry::SfuMode::parse(m);
        app.db.execute("UPDATE media_nodes SET sfu_mode = ?1 WHERE id = ?2", [mode.as_str(), id.as_str()]).await?;
        app.logs.info(format!("Mídia: SFU do nó {id} em \"{}\" por {}", mode.as_str(), me.username));
    }
    load_priorities(&app).await;
    app.hub.media_changed();
    Ok(Json(view(&app, true).await?))
}

async fn admin_remove(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if !rights(&app, &me).await? {
        return Err(forbidden());
    }
    app.db.execute("DELETE FROM media_nodes WHERE id = ?1", [id.as_str()]).await?;
    app.media.kick(&id);
    load_priorities(&app).await;
    app.hub.media_changed();
    app.logs.info(format!("Mídia: nó {id} removido por {}", me.username));
    Ok(Json(view(&app, true).await?))
}
