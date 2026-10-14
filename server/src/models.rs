//! Tipos expostos pela API e mapeamento de linhas do banco.
use crate::db::DbResult;
use libsql::Row;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    /// Caminho relativo da foto (com versão para o cache), ou `None` para o avatar com inicial.
    pub avatar_url: Option<String>,
    /// Mensagem pessoal ("Sobre mim"), exibida abaixo do nome como no Messenger.
    pub bio: String,
    /// Cores escolhidas para o nome e para a mensagem pessoal (`#rrggbb`).
    pub name_color: Option<String>,
    pub bio_color: Option<String>,
    /// Perfil de outro PC da rede local, conectado como convidado (só nos nós locais).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub lan: bool,
}

pub fn avatar_url(user_id: &str, avatar_at: Option<i64>) -> Option<String> {
    avatar_at.map(|v| format!("/api/users/{user_id}/avatar?v={v}"))
}

/// Espera as colunas: id, username, display_name, avatar_color, avatar_at, bio, name_color, bio_color,
/// origin (a partir de `start`).
pub const USER_COLS: &str =
    "u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin";
pub const USER_COLS_LEN: i32 = 9;
pub fn user_at(r: &Row, start: i32) -> DbResult<User> {
    let id: String = r.get(start)?;
    let avatar_at: Option<i64> = r.get(start + 4)?;
    Ok(User {
        avatar_url: avatar_url(&id, avatar_at),
        id,
        username: r.get(start + 1)?,
        display_name: r.get(start + 2)?,
        avatar_color: r.get(start + 3)?,
        bio: r.get::<Option<String>>(start + 5)?.unwrap_or_default(),
        name_color: r.get(start + 6)?,
        bio_color: r.get(start + 7)?,
        lan: r.get::<Option<String>>(start + 8)?.as_deref() == Some("lan"),
    })
}
/// `#rrggbb` válido (cores do nome e da mensagem pessoal).
pub fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

pub fn user_from_row(r: &Row) -> DbResult<User> {
    user_at(r, 0)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guild {
    pub id: String,
    pub name: String,
    pub icon_color: String,
    pub owner_id: String,
    pub invite_code: String,
}

pub const GUILD_COLS: &str = "g.id, g.name, g.icon_color, g.owner_id, g.invite_code";
pub fn guild_from_row(r: &Row) -> DbResult<Guild> {
    Ok(Guild { id: r.get(0)?, name: r.get(1)?, icon_color: r.get(2)?, owner_id: r.get(3)?, invite_code: r.get(4)? })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub guild_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub position: i64,
}

pub const CHANNEL_COLS: &str = "c.id, c.guild_id, c.name, c.type, c.position";
pub fn channel_from_row(r: &Row) -> DbResult<Channel> {
    Ok(Channel { id: r.get(0)?, guild_id: r.get(1)?, name: r.get(2)?, kind: r.get(3)?, position: r.get(4)? })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub content: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub author: User,
}

pub const MESSAGE_SELECT: &str = "SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at, \
     u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin FROM messages m JOIN users u ON u.id = m.author_id";
/// Mesmo formato para mensagens diretas (`channel_id` = id da conversa).
pub const DM_MESSAGE_SELECT: &str = "SELECT m.id, m.dm_id, m.content, m.created_at, m.edited_at, \
     u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin FROM dm_messages m JOIN users u ON u.id = m.author_id";
pub fn message_from_row(r: &Row) -> DbResult<Message> {
    Ok(Message {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        content: r.get(2)?,
        created_at: r.get(3)?,
        edited_at: r.get(4)?,
        author: user_at(r, 5)?,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildFull {
    #[serde(flatten)]
    pub guild: Guild,
    pub channels: Vec<Channel>,
    pub members: Vec<User>,
}
