//! Cargos (os "times" do HardLine): cada servidor tem os seus (nome, cor e quem tem cada um; uma pessoa pode
//! ter vários). Quem tem a permissão de gerenciar cargos (`perm::ROLES`; os administradores sempre) cria,
//! edita e apaga. Os membros do servidor recebem a lista inteira a cada mudança (`roles:update`). Um cargo
//! pode dar permissões a quem o tem (somadas às da pessoa; veja `perm::EFFECTIVE_SQL`): essas, e quem tem um
//! cargo que as dá, só os administradores mudam (senão quem gerencia cargos se daria permissões).
//!
//! No app, o cargo aparece como uma etiqueta colorida ao lado do nome, sem tomar o lugar da mensagem pessoal.
//! É o módulo `roles` (veja `crate::modules`): desligado, as rotas somem e os cargos não dão permissões.
use crate::api::{is_member, perm, require_perm, ApiError, AuthUser};
use crate::host::App;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

type AppState = State<Arc<App>>;
type ApiResult<T> = Result<T, ApiError>;

/// Cargos por servidor e o tamanho do nome.
const MAX_ROLES: usize = 50;
const MAX_ROLE_NAME: usize = 32;

pub fn router() -> Router<Arc<App>> {
    Router::new()
        .route("/api/guilds/{id}/roles", get(list_roles).post(create_role))
        .route("/api/roles/{id}", patch(update_role).delete(delete_role))
}

fn bad(msg: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}
fn not_found(msg: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, msg)
}
fn forbidden(msg: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, msg)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    id: String,
    name: String,
    color: String,
    /// Permissões que o cargo dá a quem o tem (nunca administrador).
    perms: i64,
    /// Quem tem o cargo (só quem ainda é membro do servidor).
    members: Vec<String>,
}

/// Os cargos do servidor, na ordem em que foram criados.
pub async fn roles_of(app: &App, guild_id: &str) -> ApiResult<Vec<Role>> {
    let mut roles: Vec<Role> = app
        .db
        .query_all("SELECT id, name, color, perms FROM roles WHERE guild_id = ?1 ORDER BY created_at, id", [guild_id], |r| {
            Ok(Role { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, perms: r.get(3)?, members: Vec::new() })
        })
        .await?;
    let rows = app
        .db
        .query_all(
            "SELECT rm.role_id, rm.user_id FROM role_members rm JOIN roles r ON r.id = rm.role_id \
             JOIN guild_members m ON m.guild_id = r.guild_id AND m.user_id = rm.user_id WHERE r.guild_id = ?1",
            [guild_id],
            |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?)),
        )
        .await?;
    let mut by: HashMap<String, Vec<String>> = HashMap::new();
    for (role, user) in rows {
        by.entry(role).or_default().push(user);
    }
    for r in &mut roles {
        r.members = by.remove(&r.id).unwrap_or_default();
    }
    Ok(roles)
}

/// Avisa todos do servidor da lista nova de cargos.
async fn announce(app: &App, guild_id: &str) -> ApiResult<Vec<Role>> {
    let roles = roles_of(app, guild_id).await?;
    app.hub.to_guild(guild_id, "roles:update", json!({ "guildId": guild_id, "roles": roles }));
    Ok(roles)
}

/// Quem saiu do servidor perde os cargos dele (voltando, entra sem nenhum).
pub async fn forget_member(app: &App, guild_id: &str, user_id: &str) -> ApiResult<()> {
    app.db
        .execute(
            "DELETE FROM role_members WHERE user_id = ?1 AND role_id IN (SELECT id FROM roles WHERE guild_id = ?2)",
            [user_id, guild_id],
        )
        .await?;
    Ok(())
}

/// Servidor excluído: os cargos dele também.
pub async fn forget_guild(app: &App, guild_id: &str) -> ApiResult<()> {
    app.db.execute("DELETE FROM role_members WHERE role_id IN (SELECT id FROM roles WHERE guild_id = ?1)", [guild_id]).await?;
    app.db.execute("DELETE FROM roles WHERE guild_id = ?1", [guild_id]).await?;
    Ok(())
}

async fn list_roles(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Role>>> {
    if !is_member(&app, &id, &me.id).await? {
        return Err(not_found("Servidor não encontrado"));
    }
    Ok(Json(roles_of(&app, &id).await?))
}

#[derive(Deserialize)]
struct RoleBody {
    name: Option<String>,
    color: Option<String>,
    members: Option<Vec<String>>,
    perms: Option<i64>,
}

/// As permissões que um cargo pode dar (administrador não).
fn role_perms(bits: i64) -> i64 {
    bits & (perm::ALL & !perm::ADMIN)
}

fn role_name(name: &str) -> ApiResult<String> {
    let name: String = name.trim().chars().take(MAX_ROLE_NAME).collect();
    if name.is_empty() {
        return Err(bad("Dê um nome ao cargo"));
    }
    Ok(name)
}

/// Grava quem tem o cargo (só membros do servidor; os outros ids são ignorados).
async fn set_members(app: &App, guild_id: &str, role_id: &str, members: &[String]) -> ApiResult<()> {
    app.db.execute("DELETE FROM role_members WHERE role_id = ?1", [role_id]).await?;
    let mut seen = HashSet::new();
    for user in members.iter().filter(|u| seen.insert(u.as_str())) {
        if is_member(app, guild_id, user).await? {
            app.db.execute("INSERT INTO role_members (role_id, user_id) VALUES (?1, ?2)", [role_id, user.as_str()]).await?;
        }
    }
    Ok(())
}

async fn create_role(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>, Json(body): Json<RoleBody>) -> ApiResult<Json<Vec<Role>>> {
    let mine = require_perm(&app, &id, &me.id, perm::ROLES, "Você não pode criar cargos neste servidor").await?;
    let name = role_name(body.name.as_deref().unwrap_or_default())?;
    let bits = role_perms(body.perms.unwrap_or(0));
    if bits != 0 && !perm::has(mine, perm::ADMIN) {
        return Err(forbidden("Só administradores dão permissões a um cargo"));
    }
    let color = body.color.filter(|c| crate::models::valid_color(c)).ok_or_else(|| bad("Cor inválida (use #rrggbb)"))?;
    let count = app.db.query_one("SELECT COUNT(*) FROM roles WHERE guild_id = ?1", [id.as_str()], |r| r.get::<i64>(0)).await?.unwrap_or(0);
    if count as usize >= MAX_ROLES {
        return Err(bad("Este servidor já tem o máximo de cargos"));
    }
    let role_id = uuid::Uuid::new_v4().to_string();
    app.db
        .execute(
            "INSERT INTO roles (id, guild_id, name, color, created_at, perms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            libsql::params![role_id.as_str(), id.as_str(), name.as_str(), color.as_str(), crate::now_ms(), bits],
        )
        .await?;
    set_members(&app, &id, &role_id, body.members.as_deref().unwrap_or_default()).await?;
    app.audit(crate::audit::Entry::new(&id, "settings.role_create", &me.id).detail(json!({ "name": name })));
    Ok(Json(announce(&app, &id).await?))
}

/// O servidor do cargo e as permissões que ele dá, se quem pede pode gerenciar os cargos dele. Cargo que dá
/// permissões: só administradores mexem.
async fn managed_role(app: &App, role_id: &str, user_id: &str) -> ApiResult<(String, i64, bool)> {
    let (guild, bits) = app
        .db
        .query_one("SELECT guild_id, perms FROM roles WHERE id = ?1", [role_id], |r| Ok((r.get::<String>(0)?, r.get::<i64>(1)?)))
        .await?
        .ok_or_else(|| not_found("Cargo não encontrado"))?;
    let mine = require_perm(app, &guild, user_id, perm::ROLES, "Você não pode mudar os cargos deste servidor").await?;
    Ok((guild, bits, perm::has(mine, perm::ADMIN)))
}

async fn update_role(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>, Json(body): Json<RoleBody>) -> ApiResult<Json<Vec<Role>>> {
    let (guild, bits, admin) = managed_role(&app, &id, &me.id).await?;
    let next = body.perms.map(role_perms);
    if next.is_some_and(|n| n != bits) && !admin {
        return Err(forbidden("Só administradores mudam as permissões de um cargo"));
    }
    if body.members.is_some() && bits != 0 && !admin {
        return Err(forbidden("Este cargo dá permissões: só administradores escolhem quem o tem"));
    }
    if let Some(name) = &body.name {
        app.db.execute("UPDATE roles SET name = ?1 WHERE id = ?2", [role_name(name)?.as_str(), id.as_str()]).await?;
    }
    if let Some(color) = &body.color {
        if !crate::models::valid_color(color) {
            return Err(bad("Cor inválida (use #rrggbb)"));
        }
        app.db.execute("UPDATE roles SET color = ?1 WHERE id = ?2", [color.as_str(), id.as_str()]).await?;
    }
    if let Some(members) = &body.members {
        set_members(&app, &guild, &id, members).await?;
    }
    if let Some(n) = next.filter(|n| *n != bits) {
        app.db.execute("UPDATE roles SET perms = ?1 WHERE id = ?2", libsql::params![n, id.as_str()]).await?;
        app.audit(crate::audit::Entry::new(&guild, "settings.role_perms", &me.id).detail(json!({ "name": role_label(&app, &id).await, "perms": n })));
    }
    if body.name.is_some() || body.color.is_some() || body.members.is_some() {
        app.audit(crate::audit::Entry::new(&guild, "settings.role_update", &me.id).detail(json!({ "name": role_label(&app, &id).await })));
    }
    Ok(Json(announce(&app, &guild).await?))
}

async fn delete_role(State(app): AppState, AuthUser(me, _): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Vec<Role>>> {
    let (guild, bits, admin) = managed_role(&app, &id, &me.id).await?;
    if bits != 0 && !admin {
        return Err(forbidden("Este cargo dá permissões: só administradores o apagam"));
    }
    let name = role_label(&app, &id).await;
    app.db.execute("DELETE FROM role_members WHERE role_id = ?1", [id.as_str()]).await?;
    app.db.execute("DELETE FROM roles WHERE id = ?1", [id.as_str()]).await?;
    app.audit(crate::audit::Entry::new(&guild, "settings.role_delete", &me.id).detail(json!({ "name": name })));
    Ok(Json(announce(&app, &guild).await?))
}

/// O nome do cargo (para o registro do servidor).
async fn role_label(app: &App, role_id: &str) -> String {
    app.db.query_one("SELECT name FROM roles WHERE id = ?1", [role_id], |r| r.get::<String>(0)).await.ok().flatten().unwrap_or_default()
}
