//! Banco de dados Turso / libSQL.
//!
//! Modos (variáveis de ambiente):
//! - Local (padrão):          arquivo `<data_dir>/padospeak.db`
//! - `turso dev` (sqld local): `DATABASE_URL=http://127.0.0.1:8080`
//! - Turso Cloud:             `DATABASE_URL=libsql://<db>.turso.io` + `TURSO_AUTH_TOKEN`
//! - Réplica embarcada:       `TURSO_SYNC_URL=libsql://...` + `TURSO_AUTH_TOKEN` (arquivo local sincronizado)
//!
//! O texto das mensagens é guardado cifrado (veja `crypto.rs`).
use crate::crypto::Cipher;
use libsql::{params::IntoParams, Builder, Connection, Database, Row};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub type DbResult<T> = Result<T, libsql::Error>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    pub mode: &'static str,
    pub location: String,
    /// Problema com a chave das mensagens (aparece no log e no painel).
    pub key_warning: Option<String>,
}

#[derive(Clone)]
pub struct Db {
    database: Arc<Database>,
    local: bool,
    pub info: DbInfo,
    /// Cifra o texto das mensagens antes de gravar e abre ao ler.
    pub cipher: Cipher,
}

const MIGRATIONS: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_color TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON guild_members(user_id);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
"#;

/// Cada item leva o banco para a versão indicada.
const VERSIONED: &[(i64, &str)] = &[
    (
    2,
    r#"
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_at INTEGER;
CREATE TABLE IF NOT EXISTS avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
-- Par canônico (user_a < user_b); requester_id indica quem pediu.
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  requester_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b);
CREATE TABLE IF NOT EXISTS dm_channels (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_dm_b ON dm_channels(user_b);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  dm_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dm_messages ON dm_messages(dm_id, created_at);
"#,
    ),
    (
        3,
        r#"
-- Status escolhido pelo usuário (online, away, busy, invisible) e "chamar atenção".
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
ALTER TABLE users ADD COLUMN allow_nudges INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS nudge_blocks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, blocked_id)
);
"#,
    ),
    (
        4,
        r#"
-- Cores do nome e da mensagem pessoal; origem do perfil ('local' = conta deste servidor,
-- 'lan' = perfil de outro PC da rede, autenticado pela chave do PC dele na primeira conexão).
ALTER TABLE users ADD COLUMN name_color TEXT;
ALTER TABLE users ADD COLUMN bio_color TEXT;
ALTER TABLE users ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN lan_key_hash TEXT;
"#,
    ),
    (
        5,
        r#"
-- Coleção de stickers de cada pessoa (PNG, JPEG, WebP ou GIF animado).
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stickers_owner ON stickers(owner_id, hash);
"#,
    ),
    (
        6,
        r#"
-- Cor do banner do perfil (acima da foto).
ALTER TABLE users ADD COLUMN banner_color TEXT;
"#,
    ),
    (
        7,
        r#"
-- Aparelhos inscritos nas notificações push (navegador ou app instalado no celular).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
"#,
    ),
    (
        8,
        r#"
-- Responder: a mensagem guarda a que ela responde.
ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE dm_messages ADD COLUMN reply_to TEXT;
-- Arquivos enviados nas conversas (o conteúdo fica no disco, cifrado).
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_guild ON files(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel_id);
-- Ícone do servidor (imagem escolhida pelo dono).
ALTER TABLE guilds ADD COLUMN icon_at INTEGER;
CREATE TABLE IF NOT EXISTS guild_icons (
  guild_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
"#,
    ),
    (
        9,
        r#"
-- Reações nas mensagens (canais e conversas diretas): um emoticon por pessoa, cada um conta uma vez.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id, created_at);
"#,
    ),
    (
        10,
        r#"
-- Permissões por membro (bits: 1 admin, 2 convidar, 4 criar/editar canais). O dono tem todas.
ALTER TABLE guild_members ADD COLUMN perms INTEGER NOT NULL DEFAULT 0;
-- Músicas favoritas de cada pessoa.
CREATE TABLE IF NOT EXISTS music_favorites (
  user_id TEXT NOT NULL,
  track_key TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  page_url TEXT NOT NULL,
  thumbnail TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_key)
);
-- Músicas tocadas em cada servidor (para "Mais tocadas"; guarda só as últimas 2 semanas).
CREATE TABLE IF NOT EXISTS music_plays (
  guild_id TEXT NOT NULL,
  track_key TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  page_url TEXT NOT NULL,
  thumbnail TEXT,
  duration_ms INTEGER,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_music_plays ON music_plays(guild_id, played_at);
-- Canais privados: só quem está em channel_access (além do dono e dos admins) vê.
ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS channel_access (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_access_user ON channel_access(user_id);
-- Arquivos comprimidos (gzip) no disco: `encoding` e o tamanho ocupado.
ALTER TABLE files ADD COLUMN encoding TEXT;
ALTER TABLE files ADD COLUMN stored INTEGER;
"#,
    ),
    (
        11,
        r#"
-- Permissões: quem não está na lista personalizada (custom = 0) tem as do padrão do servidor
-- (bits como em `perms`; 2 = convidar). Quem já tinha alguma permissão entra na lista.
ALTER TABLE guilds ADD COLUMN default_perms INTEGER NOT NULL DEFAULT 2;
ALTER TABLE guild_members ADD COLUMN custom INTEGER NOT NULL DEFAULT 0;
UPDATE guild_members SET custom = 1 WHERE perms != 0;
-- Validade (ms) dos arquivos e das mensagens de voz novas de cada servidor (NULL = não expiram).
ALTER TABLE guilds ADD COLUMN file_ttl_ms INTEGER;
ALTER TABLE guilds ADD COLUMN voice_ttl_ms INTEGER;
-- Arquivos: quando expiram, se passaram do tamanho normal (big), se são mensagem de voz e a
-- mensagem que os mostra (some junto quando o arquivo expira).
ALTER TABLE files ADD COLUMN expires_at INTEGER;
ALTER TABLE files ADD COLUMN big INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN kind TEXT;
ALTER TABLE files ADD COLUMN message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);
-- Notificações de cada pessoa em cada servidor (JSON).
CREATE TABLE IF NOT EXISTS guild_notify (
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  settings TEXT NOT NULL,
  PRIMARY KEY (user_id, guild_id)
);
"#,
    ),
    (
        12,
        r#"
-- Cor padrão das mensagens de cada pessoa e, no servidor, a cor do servidor e como ela se combina
-- com a das pessoas (server = a do servidor vale; user = a de cada um; user_first = a de cada um,
-- ou a do servidor para quem não escolheu).
ALTER TABLE users ADD COLUMN message_color TEXT;
ALTER TABLE guilds ADD COLUMN msg_color TEXT;
ALTER TABLE guilds ADD COLUMN msg_color_mode TEXT NOT NULL DEFAULT 'user';
-- Som para todos quando alguém é movido de canal de voz.
ALTER TABLE guilds ADD COLUMN move_sound INTEGER NOT NULL DEFAULT 1;
-- Imagens de fundo (da tela de início de cada pessoa e de cada servidor).
ALTER TABLE users ADD COLUMN background_at INTEGER;
ALTER TABLE guilds ADD COLUMN background_at INTEGER;
CREATE TABLE IF NOT EXISTS backgrounds (
  owner_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
-- Até onde cada pessoa recebeu e leu cada conversa/canal (os "vistos").
CREATE TABLE IF NOT EXISTS read_marks (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
-- Registro do servidor: entradas e saídas, voz (com o tempo), mensagens e mudanças (detalhe cifrado).
CREATE TABLE IF NOT EXISTS guild_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  channel_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_guild_log ON guild_log(guild_id, at);
"#,
    ),
    (
        13,
        r#"
-- Painel do administrador: cada vez que o app fica aberto (plataforma, aparelho, de quando a quando).
CREATE TABLE IF NOT EXISTS app_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  device TEXT,
  os TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_end ON app_sessions(ended_at);
-- Quem o dono do app liberou para ver o painel.
CREATE TABLE IF NOT EXISTS app_admins (
  user_id TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL
);
"#,
    ),
    (
        14,
        r#"
-- Senha redefinida pelo administrador: a senha guardada é um código temporário, e no próximo login a
-- pessoa cria uma senha nova.
ALTER TABLE users ADD COLUMN must_reset INTEGER NOT NULL DEFAULT 0;
"#,
    ),
];

impl Db {
    pub async fn open(data_dir: &Path) -> Result<Self, crate::BoxError> {
        let url = std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty());
        let token = std::env::var("TURSO_AUTH_TOKEN").unwrap_or_default();
        let sync_url = std::env::var("TURSO_SYNC_URL").ok().filter(|s| !s.is_empty());

        let local_path = match url.as_deref() {
            Some(u) if u.starts_with("file:") => u.trim_start_matches("file:").to_string(),
            _ => data_dir.join("padospeak.db").to_string_lossy().into_owned(),
        };

        let (database, local, info) = if let Some(sync) = sync_url {
            std::fs::create_dir_all(data_dir)?;
            let db = Builder::new_remote_replica(&local_path, sync.clone(), token)
                .sync_interval(Duration::from_secs(60))
                .read_your_writes(true)
                .build()
                .await?;
            (db, false, DbInfo { mode: "embedded-replica", location: format!("{local_path} ⇄ {sync}"), key_warning: None })
        } else if let Some(u) = url.filter(|u| !u.starts_with("file:")) {
            let db = Builder::new_remote(u.clone(), token).build().await?;
            (db, false, DbInfo { mode: "remote", location: u, key_warning: None })
        } else {
            if let Some(parent) = Path::new(&local_path).parent() {
                std::fs::create_dir_all(parent)?;
            }
            let db = Builder::new_local(&local_path).build().await?;
            (db, true, DbInfo { mode: "local", location: local_path, key_warning: None })
        };

        let cipher = Cipher::load(data_dir)?;
        let mut db = Db { database: Arc::new(database), local, info, cipher };
        let conn = db.conn().await?;
        if db.local {
            conn.query("PRAGMA journal_mode = WAL", ()).await?;
        }
        conn.execute_batch(MIGRATIONS).await?;
        db.migrate().await?;
        db.info.key_warning = db.encrypt_legacy().await?;
        Ok(db)
    }

    /// Cifra as mensagens gravadas antes da criptografia, sem perder nenhuma (em lotes; pode ser
    /// interrompido e retomado). Devolve um aviso se a chave não for a mesma das mensagens já cifradas.
    async fn encrypt_legacy(&self) -> Result<Option<String>, crate::BoxError> {
        let fingerprint = &self.cipher.fingerprint;
        let warning = match self.get_setting("message_key").await? {
            Some(saved) if &saved != fingerprint => Some(format!(
                "A chave das mensagens mudou (antes {saved}, agora {fingerprint}): as mensagens cifradas com a chave \
                 antiga não podem ser lidas. Restaure a chave antiga (MESSAGE_KEY ou chave-mensagens.key)."
            )),
            Some(_) => None,
            None => {
                self.set_setting("message_key", fingerprint).await?;
                None
            }
        };
        for table in ["messages", "dm_messages"] {
            loop {
                let pending = self
                    .query_all(
                        &format!("SELECT id, content FROM {table} WHERE content NOT LIKE 'enc1:%' LIMIT 500"),
                        (),
                        |r| Ok((r.get::<String>(0)?, r.get::<String>(1)?)),
                    )
                    .await?;
                if pending.is_empty() {
                    break;
                }
                let conn = self.conn().await?;
                let tx = conn.transaction().await?;
                for (id, content) in &pending {
                    tx.execute(&format!("UPDATE {table} SET content = ?1 WHERE id = ?2"), [self.cipher.seal(content).as_str(), id.as_str()])
                        .await?;
                }
                tx.commit().await?;
            }
        }
        Ok(warning)
    }

    /// Migrações incrementais (ALTER TABLE etc.), controladas por `settings.schema_version`.
    async fn migrate(&self) -> Result<(), crate::BoxError> {
        let version: i64 = self.get_setting("schema_version").await?.and_then(|v| v.parse().ok()).unwrap_or(1);
        for (target, sql) in VERSIONED.iter().filter(|(v, _)| *v > version) {
            self.conn().await?.execute_batch(sql).await?;
            self.set_setting("schema_version", &target.to_string()).await?;
        }
        Ok(())
    }

    /// Nova conexão (barata). Em modo local, cada conexão ganha busy_timeout e FKs.
    pub async fn conn(&self) -> DbResult<Connection> {
        let conn = self.database.connect()?;
        if self.local {
            conn.query("PRAGMA busy_timeout = 5000", ()).await?;
            conn.execute("PRAGMA foreign_keys = ON", ()).await?;
        }
        Ok(conn)
    }

    pub async fn query_all<T>(
        &self,
        sql: &str,
        params: impl IntoParams,
        map: impl Fn(&Row) -> DbResult<T>,
    ) -> DbResult<Vec<T>> {
        let conn = self.conn().await?;
        let mut rows = conn.query(sql, params).await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(map(&row)?);
        }
        Ok(out)
    }

    pub async fn query_one<T>(
        &self,
        sql: &str,
        params: impl IntoParams,
        map: impl Fn(&Row) -> DbResult<T>,
    ) -> DbResult<Option<T>> {
        let conn = self.conn().await?;
        let mut rows = conn.query(sql, params).await?;
        match rows.next().await? {
            Some(row) => Ok(Some(map(&row)?)),
            None => Ok(None),
        }
    }

    pub async fn execute(&self, sql: &str, params: impl IntoParams) -> DbResult<u64> {
        self.conn().await?.execute(sql, params).await
    }

    pub async fn get_setting(&self, key: &str) -> DbResult<Option<String>> {
        self.query_one("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get::<String>(0)).await
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> DbResult<()> {
        self.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .await?;
        Ok(())
    }
}
