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
    /// Cor padrão das mensagens da pessoa (`#rrggbb`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_color: Option<String>,
}

pub fn avatar_url(user_id: &str, avatar_at: Option<i64>) -> Option<String> {
    avatar_at.map(|v| format!("/api/users/{user_id}/avatar?v={v}"))
}

/// Espera as colunas: id, username, display_name, avatar_color, avatar_at, bio, name_color, bio_color,
/// origin, banner_color, message_color (a partir de `start`).
pub const USER_COLS: &str = "u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, \
     u.origin, u.banner_color, u.message_color";
pub const USER_COLS_LEN: i32 = 11;
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
        message_color: r.get(start + 10)?,
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
    /// Imagem do ícone (com versão para o cache), ou `None` para as iniciais coloridas.
    pub icon_url: Option<String>,
    /// Permissões de quem não está na lista personalizada (bits de `crate::api::perm`, sem admin).
    pub default_perms: i64,
    /// Validade dos arquivos e das mensagens de voz novas (ms); `None` = não expiram.
    pub file_ttl_ms: Option<i64>,
    pub voice_ttl_ms: Option<i64>,
    /// Imagem de fundo do servidor (com versão para o cache).
    pub background_url: Option<String>,
    /// Cor das mensagens no servidor e como ela se combina com a de cada pessoa (`server`, `user`, `user_first`).
    pub msg_color: Option<String>,
    pub msg_color_mode: String,
    /// Som para todos quando alguém é movido de canal de voz.
    pub move_sound: bool,
}

pub const GUILD_COLS: &str = "g.id, g.name, g.icon_color, g.owner_id, g.invite_code, g.icon_at, g.default_perms, g.file_ttl_ms, \
     g.voice_ttl_ms, g.background_at, g.msg_color, g.msg_color_mode, g.move_sound";
/// Quantas colunas `GUILD_COLS` ocupa (as seguintes começam neste índice).
pub const GUILD_COLS_LEN: i32 = 13;
pub fn guild_from_row(r: &Row) -> DbResult<Guild> {
    let id: String = r.get(0)?;
    let icon_at: Option<i64> = r.get(5)?;
    Ok(Guild {
        icon_url: icon_at.map(|v| format!("/api/guilds/{id}/icon?v={v}")),
        id,
        name: r.get(1)?,
        icon_color: r.get(2)?,
        owner_id: r.get(3)?,
        invite_code: r.get(4)?,
        default_perms: r.get(6)?,
        file_ttl_ms: r.get(7)?,
        voice_ttl_ms: r.get(8)?,
        background_url: r.get::<Option<i64>>(9)?.map(|v| format!("/api/backgrounds/{}?v={v}", r.get::<String>(0).unwrap_or_default())),
        msg_color: r.get(10)?,
        msg_color_mode: r.get(11)?,
        move_sound: r.get::<i64>(12)? != 0,
    })
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
    /// Só quem tem acesso (e o dono/admins) vê o canal.
    pub private: bool,
}

pub const CHANNEL_COLS: &str = "c.id, c.guild_id, c.name, c.type, c.position, c.private";
pub fn channel_from_row(r: &Row) -> DbResult<Channel> {
    Ok(Channel {
        id: r.get(0)?,
        guild_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        position: r.get(4)?,
        private: r.get::<i64>(5)? != 0,
    })
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
    /// Mensagem respondida (id), mesmo que ela tenha sido apagada depois.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// Trecho da mensagem respondida, para mostrar acima da resposta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<ReplyRef>,
    /// Reações (emoticon e quem reagiu), na ordem em que apareceram.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<Reaction>,
    /// Mensagem com arquivo/áudio que expira: some (com o arquivo) neste horário.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    pub users: Vec<String>,
}

/// Agrupa linhas (mensagem, emoticon, usuário) já em ordem de chegada.
pub fn group_reactions(rows: Vec<(String, String, String)>) -> std::collections::HashMap<String, Vec<Reaction>> {
    let mut out: std::collections::HashMap<String, Vec<Reaction>> = std::collections::HashMap::new();
    for (message_id, emoji, user_id) in rows {
        let list = out.entry(message_id).or_default();
        match list.iter_mut().find(|r| r.emoji == emoji) {
            Some(r) => r.users.push(user_id),
            None => list.push(Reaction { emoji, users: vec![user_id] }),
        }
    }
    out
}

/// Preenche as reações (e a validade dos arquivos) de uma lista de mensagens.
pub async fn attach_reactions(db: &crate::db::Db, list: &mut [Message]) -> crate::db::DbResult<()> {
    if list.is_empty() {
        return Ok(());
    }
    let marks = (1..=list.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN ({marks}) ORDER BY created_at"
    );
    let ids: Vec<String> = list.iter().map(|m| m.id.clone()).collect();
    let rows = db
        .query_all(&sql, libsql::params_from_iter(ids), |r| {
            Ok((r.get::<String>(0)?, r.get::<String>(1)?, r.get::<String>(2)?))
        })
        .await?;
    let mut grouped = group_reactions(rows);
    for m in list.iter_mut() {
        m.reactions = grouped.remove(&m.id).unwrap_or_default();
    }
    // Arquivos e áudios com validade.
    let ids: Vec<String> = list.iter().filter(|m| is_file_message(&m.content)).map(|m| m.id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let marks = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT message_id, expires_at FROM files WHERE expires_at IS NOT NULL AND message_id IN ({marks})");
    let expiring: std::collections::HashMap<String, i64> = db
        .query_all(&sql, libsql::params_from_iter(ids), |r| Ok((r.get::<String>(0)?, r.get::<i64>(1)?)))
        .await?
        .into_iter()
        .collect();
    for m in list.iter_mut() {
        m.expires_at = expiring.get(&m.id).copied();
    }
    Ok(())
}

/// Mensagem que é um arquivo (`[arquivo:…]`) ou uma mensagem de voz (`[voz:…]`).
pub fn is_file_message(content: &str) -> bool {
    content.starts_with("[arquivo:") || content.starts_with("[voz:")
}

/// Id do arquivo de uma mensagem `[arquivo:<id>:…]` ou `[voz:<id>:…]`.
pub fn message_file_id(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("[arquivo:").or_else(|| content.strip_prefix("[voz:"))?;
    let id = rest.split([':', ']']).next()?;
    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRef {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    /// Começo do texto (sem formatação); sticker e arquivo viram uma descrição curta.
    pub preview: String,
}

/// Como a mensagem aparece citada numa resposta.
pub fn reply_preview(content: &str) -> String {
    // Sticker, arquivo e foto/vídeo podem vir com um texto junto (na linha de baixo).
    let (tag, caption) = match content.split_once("]
") {
        Some((tag, caption)) if content.starts_with('[') => (tag, plain_text(caption)),
        _ => (content.trim_end_matches(']'), String::new()),
    };
    let with = |label: String| if caption.trim().is_empty() { label } else { format!("{label} — {}", short(&caption, 80)) };
    if tag.starts_with("[sticker:") {
        return with("Sticker".into());
    }
    if let Some(rest) = tag.strip_prefix("[arquivo:") {
        let name = rest.splitn(4, ':').nth(3).unwrap_or("arquivo");
        return with(format!("📎 {name}"));
    }
    if tag.starts_with("[voz:") {
        return "🎤 Mensagem de voz".into();
    }
    short(&plain_text(content), 120)
}

fn short(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

pub const MESSAGE_SELECT: &str = "SELECT m.id, m.channel_id, m.content, m.created_at, m.edited_at, \
     u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin, u.banner_color, \
     u.message_color, m.reply_to, r.id, r.content, ru.id, ru.display_name \
     FROM messages m JOIN users u ON u.id = m.author_id \
     LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.author_id";
/// Mesmo formato para mensagens diretas (`channel_id` = id da conversa).
pub const DM_MESSAGE_SELECT: &str = "SELECT m.id, m.dm_id, m.content, m.created_at, m.edited_at, \
     u.id, u.username, u.display_name, u.avatar_color, u.avatar_at, u.bio, u.name_color, u.bio_color, u.origin, u.banner_color, \
     u.message_color, m.reply_to, r.id, r.content, ru.id, ru.display_name \
     FROM dm_messages m JOIN users u ON u.id = m.author_id \
     LEFT JOIN dm_messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.author_id";
pub fn message_from_row(r: &Row) -> DbResult<Message> {
    Ok(Message {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        content: r.get(2)?,
        created_at: r.get(3)?,
        edited_at: r.get(4)?,
        author: user_at(r, 5)?,
        reply_to: r.get(5 + USER_COLS_LEN)?,
        // O texto citado ainda está cifrado aqui; `open_message` abre e resume.
        reply: match r.get::<Option<String>>(6 + USER_COLS_LEN)? {
            Some(id) => Some(ReplyRef {
                id,
                preview: r.get(7 + USER_COLS_LEN)?,
                author_id: r.get(8 + USER_COLS_LEN)?,
                author_name: r.get::<Option<String>>(9 + USER_COLS_LEN)?.unwrap_or_default(),
            }),
            None => None,
        },
        reactions: Vec::new(),
        expires_at: None,
    })
}

/// Decifra o texto (e o trecho citado) de uma mensagem lida do banco.
pub fn open_message(db: &crate::db::Db, m: &mut Message) {
    m.content = db.cipher.reveal(&m.content);
    if let Some(r) = &mut m.reply {
        r.preview = reply_preview(&db.cipher.reveal(&r.preview));
        r.author_name = plain_text(&r.author_name);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuildFull {
    #[serde(flatten)]
    pub guild: Guild,
    pub channels: Vec<Channel>,
    pub members: Vec<User>,
    /// Permissões de quem tem alguma (id → bits de `crate::api::perm`); o dono não aparece (tem todas).
    pub perms: std::collections::HashMap<String, i64>,
    /// Canal privado → quem tem acesso (só para administradores).
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub channel_access: std::collections::HashMap<String, Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn citacao_de_arquivo_com_texto() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(reply_preview(&format!("[arquivo:{id}:10:image/png:foto.png]")), "📎 foto.png");
        assert_eq!(reply_preview(&format!("[arquivo:{id}:10:image/png:foto.png]
olha **isso**")), "📎 foto.png — olha isso");
        assert_eq!(reply_preview("[sticker:emote::)]
oi"), "Sticker — oi");
        assert_eq!(reply_preview(&format!("[voz:{id}:3000:audio/webm]")), "🎤 Mensagem de voz");
        assert_eq!(message_file_id(&format!("[voz:{id}:3000:audio/webm]")), Some(id));
        assert_eq!(message_file_id(&format!("[arquivo:{id}:1:a:b]
texto")), Some(id));
        assert_eq!(message_file_id("[arquivo:nada]"), None);
    }

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
