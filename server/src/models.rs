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
    /// Cor do banner do perfil (`#rrggbb`); sem ela, o banner usa a cor da foto.
    pub banner_color: Option<String>,
    /// Perfil de outro PC da rede local, conectado como convidado (só nos nós locais).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub lan: bool,
}

pub fn avatar_url(user_id: &str, avatar_at: Option<i64>) -> Option<String> {
    avatar_at.map(|v| format!("/api/users/{user_id}/avatar?v={v}"))
}

/// Espera as colunas: id, username, display_name, avatar_color, avatar_at, bio, name_color, bio_color,
/// origin, banner_color (a partir de `start`).
pub const USER_COLS: &str =
    "u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin, u.banner_color";
pub const USER_COLS_LEN: i32 = 10;
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
        banner_color: r.get(start + 9)?,
    })
}
/// `#rrggbb` válido (cores do nome e da mensagem pessoal).
pub fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Limites do nome e da mensagem pessoal: o que aparece na tela e o texto com as tags de formatação.
pub const NAME_MAX: usize = 32;
pub const NAME_RAW_MAX: usize = 128;
pub const BIO_MAX: usize = 190;
pub const BIO_RAW_MAX: usize = 600;

/// Quantos caracteres aparecem na tela: tags de cor (`[cor=#rrggbb]`, `[/cor]`) e marcas de
/// negrito/itálico/sublinhado/riscado não contam.
pub fn visible_len(text: &str) -> usize {
    let mut rest = text;
    let mut n = 0;
    while let Some(ch) = rest.chars().next() {
        let skip = if rest.starts_with("[cor=#") && rest.len() >= 13 && rest.as_bytes()[12] == b']' && valid_color(&rest[5..12]) {
            13
        } else if rest.starts_with("[/cor]") {
            6
        } else if rest.starts_with("**") || rest.starts_with("__") || rest.starts_with("~~") {
            2
        } else if ch == '*' {
            1
        } else {
            n += 1;
            ch.len_utf8()
        };
        rest = &rest[skip..];
    }
    n
}

/// O texto como aparece na tela, sem as tags de formatação (para notificações).
pub fn plain_text(text: &str) -> String {
    let mut rest = text;
    let mut out = String::new();
    while let Some(ch) = rest.chars().next() {
        let skip = if rest.starts_with("[cor=#") && rest.len() >= 13 && rest.as_bytes()[12] == b']' && valid_color(&rest[5..12]) {
            13
        } else if rest.starts_with("[/cor]") {
            6
        } else if rest.starts_with("**") || rest.starts_with("__") || rest.starts_with("~~") {
            2
        } else if ch == '*' {
            1
        } else {
            out.push(ch);
            ch.len_utf8()
        };
        rest = &rest[skip..];
    }
    out
}

/// Texto formatado dentro dos limites (aparado), ou `None` se o visível passar de `max`.
pub fn fit_formatted(text: &str, max: usize, raw_max: usize) -> Option<String> {
    let text = text.trim();
    (text.chars().count() <= raw_max && visible_len(text) <= max).then(|| text.to_string())
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
     u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin, u.banner_color \
     FROM messages m JOIN users u ON u.id = m.author_id";
/// Mesmo formato para mensagens diretas (`channel_id` = id da conversa).
pub const DM_MESSAGE_SELECT: &str = "SELECT m.id, m.dm_id, m.content, m.created_at, m.edited_at, \
     u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin, u.banner_color \
     FROM dm_messages m JOIN users u ON u.id = m.author_id";
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_len_ignores_format_tags() {
        assert_eq!(visible_len("Gabi"), 4);
        assert_eq!(visible_len("[cor=#d93f3a]Gabi[/cor]"), 4);
        assert_eq!(visible_len("**Ga**__bi__ ~~x~~ *y*"), 8);
        assert_eq!(visible_len("ção [cor=#zzzzzz]"), 17);
        let long = format!("[cor=#1a7fc4]{}[/cor]", "a".repeat(32));
        assert!(fit_formatted(&long, NAME_MAX, NAME_RAW_MAX).is_some());
        assert!(fit_formatted(&"a".repeat(33), NAME_MAX, NAME_RAW_MAX).is_none());
    }
}
