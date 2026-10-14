//! Painel web de hospedagem para o binário headless/VM: serve o mesmo cliente React,
//! aberto na página com o botão "Hostear", mais a API `/panel-api/*` que ela consome.
//! Fica em 127.0.0.1:3001 por padrão; exposto na rede somente com `PANEL_PASSWORD`.
use crate::{HostConfig, HostManager};
use axum::extract::{Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone)]
struct PanelState {
    host: Arc<HostManager>,
    password: Option<String>,
}

pub fn router(host: Arc<HostManager>, password: Option<String>) -> Router {
    let state = PanelState { host, password };
    Router::new()
        .route("/panel-api/status", get(status))
        .route("/panel-api/start", post(start))
        .route("/panel-api/stop", post(stop))
        .route("/panel-api/logs", get(logs))
        .fallback(crate::assets::panel_handler)
        .layer(middleware::from_fn_with_state(state.clone(), basic_auth))
        .with_state(state)
}

async fn basic_auth(State(s): State<PanelState>, req: Request, next: Next) -> Response {
    let Some(expected) = s.password.as_deref() else { return next.run(req).await };
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .and_then(|raw| String::from_utf8(raw).ok())
        .is_some_and(|cred| cred.split_once(':').is_some_and(|(_, pw)| pw == expected));
    if ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Basic realm=\"PadoSpeak\"")], "Senha necessária").into_response()
    }
}

async fn status(State(s): State<PanelState>) -> impl IntoResponse {
    Json(s.host.status().await)
}

async fn start(State(s): State<PanelState>, Json(cfg): Json<HostConfig>) -> Response {
    match s.host.start(Some(cfg)).await {
        Ok(st) => Json(st).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

async fn stop(State(s): State<PanelState>) -> impl IntoResponse {
    Json(s.host.stop().await)
}

#[derive(Deserialize)]
struct LogsQuery {
    #[serde(default)]
    after: u64,
}

async fn logs(State(s): State<PanelState>, Query(q): Query<LogsQuery>) -> impl IntoResponse {
    Json(s.host.logs_since(q.after))
}
