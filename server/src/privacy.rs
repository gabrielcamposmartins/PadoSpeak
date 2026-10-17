//! "Esconder meu perfil de": quem está na lista de alguém não recebe a foto, a mensagem pessoal (e a cor
//! dela) nem a cor do banner dessa pessoa; vê a inicial do nome, o nome e o status. Todo o resto (conversas,
//! chamadas, servidores) continua igual.
//!
//! A máscara é aplicada na saída, para cada pessoa que vai receber: no WebSocket (`Hub::run`, a escrita da
//! conexão) e nas respostas da API (`layer`). Assim vale para tudo o que leva um perfil (membros, mensagens,
//! voz, música, sons, avisos…), inclusive o que for criado depois. Só quem está na lista de alguém paga o
//! custo (reler o JSON); para os outros, é uma consulta num mapa. A foto em si (`/api/users/{id}/avatar`)
//! pede login de quem tem a lista e recusa quem está nela.
use crate::db::Db;
use crate::host::App;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header;
use axum::middleware::Next;
use axum::response::Response;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

#[derive(Default)]
pub struct Privacy {
    /// Quem vê → donos que escondem o perfil dessa pessoa.
    by_viewer: RwLock<HashMap<String, HashSet<String>>>,
    /// Dono → quantas pessoas estão na lista dele (a foto passa a pedir login).
    owners: RwLock<HashMap<String, usize>>,
}

impl Privacy {
    pub async fn load(db: &Db) -> Self {
        let me = Self::default();
        let rows = db
            .query_all("SELECT owner_id, viewer_id FROM profile_hidden", (), |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?)))
            .await
            .unwrap_or_default();
        for (owner, viewer) in rows {
            me.set(&owner, &viewer, true);
        }
        me
    }

    /// Liga ou desliga "esconder o perfil de `owner` para `viewer`".
    pub fn set(&self, owner: &str, viewer: &str, on: bool) {
        let mut by_viewer = self.by_viewer.write().unwrap();
        let mut owners = self.owners.write().unwrap();
        let set = by_viewer.entry(viewer.to_string()).or_default();
        let changed = if on { set.insert(owner.to_string()) } else { set.remove(owner) };
        if set.is_empty() {
            by_viewer.remove(viewer);
        }
        if changed {
            let n = owners.entry(owner.to_string()).or_default();
            if on {
                *n += 1;
            } else {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    owners.remove(owner);
                }
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.by_viewer.read().unwrap().is_empty()
    }

    /// Donos que escondem o perfil de `viewer` (nada: a pessoa vê tudo).
    pub fn hidden_owners(&self, viewer: &str) -> Option<HashSet<String>> {
        self.by_viewer.read().unwrap().get(viewer).cloned()
    }

    pub fn hides(&self, owner: &str, viewer: &str) -> bool {
        self.by_viewer.read().unwrap().get(viewer).is_some_and(|s| s.contains(owner))
    }

    /// `owner` esconde o perfil de alguém (a foto dele só sai para quem fez login e pode ver).
    pub fn has_list(&self, owner: &str) -> bool {
        self.owners.read().unwrap().contains_key(owner)
    }

    /// Uma mensagem do WebSocket já pronta, mascarada para `viewer` (igual, se não precisar).
    pub fn mask_text(&self, viewer: &str, text: String) -> String {
        let Some(owners) = self.hidden_owners(viewer) else { return text };
        match serde_json::from_str::<Value>(&text) {
            Ok(mut v) => {
                mask(&mut v, &owners);
                serde_json::to_string(&v).unwrap_or(text)
            }
            Err(_) => text,
        }
    }
}

/// Tira de cada perfil de `owners` (objetos com `id` e `username`) a foto, a mensagem pessoal e o banner.
pub fn mask(v: &mut Value, owners: &HashSet<String>) {
    match v {
        Value::Object(map) => {
            let is_hidden = |o: &serde_json::Map<String, Value>| {
                o.contains_key("username") && o.get("id").and_then(Value::as_str).is_some_and(|id| owners.contains(id))
            };
            if is_hidden(map) {
                for key in ["avatarUrl", "bioColor", "bannerColor"] {
                    if map.contains_key(key) {
                        map.insert(key.into(), Value::Null);
                    }
                }
                if map.contains_key("bio") {
                    map.insert("bio".into(), Value::String(String::new()));
                }
            }
            // Perfil (`/api/users/{id}`): a mensagem pessoal também vem ao lado do usuário.
            let wraps_hidden = map.get("user").and_then(Value::as_object).is_some_and(is_hidden);
            if wraps_hidden && map.contains_key("bio") {
                map.insert("bio".into(), Value::String(String::new()));
            }
            for child in map.values_mut() {
                mask(child, owners);
            }
        }
        Value::Array(items) => {
            for item in items {
                mask(item, owners);
            }
        }
        _ => {}
    }
}

/// Camada das respostas da API: para quem está na lista de alguém, as respostas em JSON saem mascaradas.
pub async fn layer(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    if app.privacy.is_empty() {
        return next.run(req).await;
    }
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string);
    let Some(token) = token else { return next.run(req).await };
    let Some(viewer) = crate::auth::user_from_token(&app.db, &token).await else { return next.run(req).await };
    let Some(owners) = app.privacy.hidden_owners(&viewer.id) else { return next.run(req).await };
    let res = next.run(req).await;
    let json = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/json"));
    if !json {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 64 << 20).await else {
        return Response::builder().status(500).body(Body::empty()).unwrap_or_default();
    };
    let out = match serde_json::from_slice::<Value>(&bytes) {
        Ok(mut v) => {
            mask(&mut v, &owners);
            serde_json::to_vec(&v).unwrap_or_else(|_| bytes.to_vec())
        }
        Err(_) => bytes.to_vec(),
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn esconde_so_de_quem_esta_na_lista() {
        let p = Privacy::default();
        p.set("ana", "chefe", true);
        assert!(p.hides("ana", "chefe"));
        assert!(!p.hides("ana", "bia"));
        assert!(p.has_list("ana"));
        // Mensagem nova no canal: o autor é a Ana.
        let msg = json!({ "ev": "message:new", "d": { "author": { "id": "ana", "username": "ana", "displayName": "Ana", "avatarColor": "#e05a4f",
            "avatarUrl": "/api/users/ana/avatar?v=1", "bio": "anime ✨", "bioColor": "#f00", "bannerColor": "#ff69b4" }, "content": "oi" } })
        .to_string();
        let masked: Value = serde_json::from_str(&p.mask_text("chefe", msg.clone())).unwrap();
        let a = &masked["d"]["author"];
        assert_eq!(a["avatarUrl"], Value::Null);
        assert_eq!(a["bio"], "");
        assert_eq!(a["bannerColor"], Value::Null);
        assert_eq!(a["bioColor"], Value::Null);
        // Nome, cor da inicial e o resto continuam.
        assert_eq!(a["displayName"], "Ana");
        assert_eq!(a["avatarColor"], "#e05a4f");
        assert_eq!(masked["d"]["content"], "oi");
        // Para quem não está na lista, nada muda.
        assert_eq!(p.mask_text("bia", msg.clone()), msg);
        // Perfil: a mensagem pessoal que vem ao lado do usuário também some.
        let mut profile = json!({ "user": { "id": "ana", "username": "ana", "bio": "anime" }, "bio": "anime", "mutualGuilds": [] });
        mask(&mut profile, &p.hidden_owners("chefe").unwrap());
        assert_eq!(profile["bio"], "");
        // Tirar da lista: volta a ver.
        p.set("ana", "chefe", false);
        assert!(!p.hides("ana", "chefe"));
        assert!(!p.has_list("ana"));
        assert!(p.is_empty());
    }
}
