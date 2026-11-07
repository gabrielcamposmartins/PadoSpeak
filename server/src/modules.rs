//! Módulos do PadoSpeak (veio do HardLine): o chat de texto (conversas, canais de texto, arquivos,
//! stickers) é o núcleo e está sempre ligado; o resto entra por módulo.
//!
//! | Módulo   | O que traz                                                     | Precisa de |
//! | -------- | -------------------------------------------------------------- | ---------- |
//! | `voice`  | chamadas de voz e vídeo, canais de voz, tela, SFU               | —          |
//! | `roles`  | cargos dos servidores (e as permissões que eles dão)            | —          |
//! | `music`  | fila de música nos canais de voz                                | `voice`    |
//! | `sounds` | sons rápidos nas chamadas                                       | `voice`    |
//! | `agent`  | conversa com o assistente (IA), que age com o acesso da pessoa  | —          |
//!
//! `agent` começa desligado (gasta a chave da API da Anthropic) e usa a mesma configuração de antes
//! (`agent_enabled`), para quem já tinha ligado continuar com ele ligado.
//!
//! Quem escolhe é o dono do app (`PUT /api/admin/modules`, evento `app:modules`) ou a variável `MODULES`
//! (ex.: `MODULES=voice,music`; `chat` sozinho deixa só o chat), que trava a escolha. Desligar um módulo
//! não apaga nada: as rotas dele respondem 404 ([`layer`]), o WebSocket recusa as operações dele
//! ([`Module::of_op`]) e o app esconde as telas. Ligado de novo, volta tudo como estava.
use crate::api::{ApiError, AuthUser};
use crate::host::App;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Module {
    Voice,
    Roles,
    Music,
    Sounds,
    Agent,
}

impl Module {
    pub const ALL: [Module; 5] = [Module::Voice, Module::Roles, Module::Music, Module::Sounds, Module::Agent];

    pub fn key(self) -> &'static str {
        match self {
            Module::Voice => "voice",
            Module::Roles => "roles",
            Module::Music => "music",
            Module::Sounds => "sounds",
            Module::Agent => "agent",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Module::Voice => "Chamadas de voz e vídeo",
            Module::Roles => "Cargos",
            Module::Music => "Música",
            Module::Sounds => "Sons rápidos",
            Module::Agent => "Assistente",
        }
    }

    /// Chave em `settings` (o assistente mantém a de antes dos módulos).
    pub fn setting(self) -> &'static str {
        match self {
            Module::Voice => "module_voice",
            Module::Roles => "module_roles",
            Module::Music => "module_music",
            Module::Sounds => "module_sounds",
            Module::Agent => "agent_enabled",
        }
    }

    /// O módulo de que este depende (a música e os sons vivem dentro das chamadas).
    pub fn requires(self) -> Option<Module> {
        match self {
            Module::Music | Module::Sounds => Some(Module::Voice),
            _ => None,
        }
    }

    /// Nome na variável `MODULES` (aceita também os nomes em português).
    pub fn parse(s: &str) -> Option<Module> {
        Some(match s.trim().to_lowercase().as_str() {
            "voice" | "voz" | "video" | "vídeo" | "calls" | "chamadas" => Module::Voice,
            "roles" | "cargos" | "teams" | "times" => Module::Roles,
            "music" | "musica" | "música" => Module::Music,
            "sounds" | "sons" | "soundboard" => Module::Sounds,
            "agent" | "agente" | "assistente" | "ia" | "ai" => Module::Agent,
            _ => return None,
        })
    }

    /// O módulo de uma operação do WebSocket (`None`: núcleo, sempre aceita).
    pub fn of_op(op: &str) -> Option<Module> {
        let prefix = op.split(':').next().unwrap_or_default();
        Some(match prefix {
            "voice" | "sfu" | "call" | "turn" => Module::Voice,
            "music" => Module::Music,
            "sound" => Module::Sounds,
            "agent" => Module::Agent,
            _ => return None,
        })
    }

    /// O módulo de uma rota da API (`None`: núcleo).
    pub fn of_path(path: &str) -> Option<Module> {
        let seg: Vec<&str> = path.trim_end_matches('/').split('/').skip(1).collect();
        Some(match seg.as_slice() {
            ["api", "roles", ..] | ["api", "guilds", _, "roles", ..] => Module::Roles,
            ["api", "music", ..] => Module::Music,
            ["api", "sounds", ..] | ["api", "users", _, "sounds"] => Module::Sounds,
            ["api", "agent", ..] => Module::Agent,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Modules {
    #[serde(default = "yes")]
    pub voice: bool,
    #[serde(default = "yes")]
    pub roles: bool,
    #[serde(default = "yes")]
    pub music: bool,
    #[serde(default = "yes")]
    pub sounds: bool,
    #[serde(default)]
    pub agent: bool,
}

fn yes() -> bool {
    true
}

impl Default for Modules {
    /// Tudo o que já existia ligado (como era antes dos módulos); o assistente desligado.
    fn default() -> Self {
        Modules { voice: true, roles: true, music: true, sounds: true, agent: false }
    }
}

impl Modules {
    /// Só o chat de texto.
    pub fn none() -> Self {
        Modules { voice: false, roles: false, music: false, sounds: false, agent: false }
    }

    pub fn has(&self, m: Module) -> bool {
        match m {
            Module::Voice => self.voice,
            Module::Roles => self.roles,
            Module::Music => self.music,
            Module::Sounds => self.sounds,
            Module::Agent => self.agent,
        }
    }

    pub fn set(&mut self, m: Module, on: bool) {
        match m {
            Module::Voice => self.voice = on,
            Module::Roles => self.roles = on,
            Module::Music => self.music = on,
            Module::Sounds => self.sounds = on,
            Module::Agent => self.agent = on,
        }
    }

    /// Desliga quem depende de um módulo desligado (sem chamadas não há música nem sons).
    pub fn normalized(mut self) -> Self {
        for m in Module::ALL {
            if self.has(m) && m.requires().is_some_and(|r| !self.has(r)) {
                self.set(m, false);
            }
        }
        self
    }

    /// Lista da variável `MODULES`: nomes separados por vírgula ou espaço; `all`/`todos` liga tudo e
    /// `chat` (o núcleo) não muda nada. Um nome desconhecido é erro, para não subir sem o que se pediu.
    pub fn from_list(list: &str) -> Result<Self, String> {
        let mut out = Modules::none();
        for name in list.split([',', ' ', ';']).map(str::trim).filter(|s| !s.is_empty()) {
            match name.to_lowercase().as_str() {
                "all" | "todos" | "tudo" => out = Modules { agent: true, ..Modules::default() },
                "chat" | "texto" | "text" => {}
                _ => out.set(Module::parse(name).ok_or_else(|| format!("módulo desconhecido em MODULES: {name}"))?, true),
            }
        }
        Ok(out.normalized())
    }

    /// Os nomes dos módulos ligados (para o log).
    pub fn describe(&self) -> String {
        let on: Vec<&str> = std::iter::once("chat").chain(Module::ALL.into_iter().filter(|m| self.has(*m)).map(Module::key)).collect();
        on.join(", ")
    }
}

/// Os módulos da variável `MODULES` (`None`: a escolha é do painel).
pub fn from_env() -> Option<Result<Modules, String>> {
    std::env::var("MODULES").ok().filter(|v| !v.trim().is_empty()).map(|v| Modules::from_list(&v))
}

/// A escolha fica travada pela variável `MODULES`?
pub fn locked() -> bool {
    matches!(from_env(), Some(Ok(_)))
}

/// Os módulos em vigor: os da variável `MODULES` (gravados também nas configurações, que o SQL das
/// permissões dos cargos consulta) ou os guardados pelo painel (o que falta vale o padrão).
pub async fn load(app: &App) -> Modules {
    match from_env() {
        Some(Ok(m)) => {
            let _ = save(app, m).await;
            return m;
        }
        Some(Err(e)) => app.logs.warn(format!("{e}; valem os módulos do painel")),
        None => {}
    }
    let mut m = Modules::default();
    for module in Module::ALL {
        if let Ok(Some(v)) = app.db.get_setting(module.setting()).await {
            m.set(module, v != "0");
        }
    }
    m.normalized()
}

pub async fn save(app: &App, m: Modules) -> Result<(), libsql::Error> {
    for module in Module::ALL {
        app.db.set_setting(module.setting(), if m.has(module) { "1" } else { "0" }).await?;
    }
    Ok(())
}

/// Liga os módulos escolhidos: grava, avisa o hub (que tira todos da voz sem as chamadas), para a música
/// se ela saiu e conta para todos os apps (`app:modules`; `app:agent` para os apps de antes dos módulos).
pub async fn apply(app: &App, m: Modules) -> Result<Modules, libsql::Error> {
    let m = m.normalized();
    let before = app.hub.modules();
    save(app, m).await?;
    app.hub.set_modules(m);
    if before.music && !m.music {
        app.music.clear_all();
    }
    if before != m {
        app.logs.info(format!("Módulos: {}", m.describe()));
        app.hub.to_all("app:modules", m);
        if before.agent != m.agent {
            app.hub.to_all("app:agent", json!({ "enabled": m.agent }));
        }
    }
    Ok(m)
}

pub fn router() -> Router<Arc<App>> {
    Router::new().route("/api/admin/modules", get(admin_get).put(admin_put))
}

fn view(m: Modules, owner: bool) -> serde_json::Value {
    let list: Vec<_> = Module::ALL
        .into_iter()
        .map(|x| json!({ "key": x.key(), "name": x.name(), "on": m.has(x), "requires": x.requires().map(Module::key) }))
        .collect();
    json!({ "modules": m, "list": list, "locked": locked(), "canEdit": owner && !locked() })
}

async fn admin_get(State(app): State<Arc<App>>, AuthUser(me, _): AuthUser) -> Result<Json<serde_json::Value>, ApiError> {
    let (can_view, owner) = crate::admin::rights(&app, &me).await?;
    if !can_view {
        return Err(ApiError(StatusCode::NOT_FOUND, "Não encontrado".into()));
    }
    Ok(Json(view(app.hub.modules(), owner)))
}

async fn admin_put(State(app): State<Arc<App>>, AuthUser(me, _): AuthUser, Json(m): Json<Modules>) -> Result<Json<serde_json::Value>, ApiError> {
    let (_, owner) = crate::admin::rights(&app, &me).await?;
    if !owner {
        return Err(ApiError(StatusCode::FORBIDDEN, "Só o dono do app escolhe os módulos".into()));
    }
    if locked() {
        return Err(ApiError(StatusCode::CONFLICT, "Os módulos estão travados pela variável MODULES do servidor".into()));
    }
    let m = apply(&app, m).await?;
    Ok(Json(view(m, owner)))
}

/// Camada da API: a rota de um módulo desligado responde 404, como se não existisse.
pub async fn layer(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    if let Some(m) = Module::of_path(req.uri().path()) {
        if !app.hub.modules().has(m) {
            let msg = format!("O módulo {} está desligado neste servidor", m.name());
            return (StatusCode::NOT_FOUND, Json(json!({ "error": msg, "module": m.key() }))).into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lista_da_variavel() {
        assert_eq!(Modules::from_list("chat").unwrap(), Modules::none());
        assert_eq!(Modules::from_list("todos").unwrap(), Modules { agent: true, ..Modules::default() });
        assert!(Modules::from_list("chat,agente").unwrap().agent);
        let m = Modules::from_list("chat, voz, cargos").unwrap();
        assert!(m.voice && m.roles && !m.music && !m.sounds);
        assert!(Modules::from_list("chat,foguete").is_err());
    }

    #[test]
    fn dependencias() {
        let m = Modules::from_list("musica,sons,cargos").unwrap();
        assert!(!m.music && !m.sounds && m.roles);
        let mut all = Modules::default();
        all.voice = false;
        let n = all.normalized();
        assert!(!n.music && !n.sounds && n.roles);
    }

    #[test]
    fn rotas_e_operacoes() {
        assert_eq!(Module::of_path("/api/guilds/g1/roles"), Some(Module::Roles));
        assert_eq!(Module::of_path("/api/roles/r1"), Some(Module::Roles));
        assert_eq!(Module::of_path("/api/music/stream/x"), Some(Module::Music));
        assert_eq!(Module::of_path("/api/users/u1/sounds"), Some(Module::Sounds));
        assert_eq!(Module::of_path("/api/sounds/board"), Some(Module::Sounds));
        assert_eq!(Module::of_path("/api/agent/messages"), Some(Module::Agent));
        assert_eq!(Module::of_path("/api/guilds/g1"), None);
        assert_eq!(Module::of_path("/api/admin/agent"), None);
        assert_eq!(Module::of_op("voice:join"), Some(Module::Voice));
        assert_eq!(Module::of_op("sfu:publish"), Some(Module::Voice));
        assert_eq!(Module::of_op("message:send"), None);
    }
}
