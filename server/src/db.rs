//! Banco de dados Turso / libSQL.
//!
//! Modos (variáveis de ambiente):
//! - Local (padrão):          arquivo `<data_dir>/padospeak.db`
//! - `turso dev` (sqld local): `DATABASE_URL=http://127.0.0.1:8080`
//! - Turso Cloud:             `DATABASE_URL=libsql://<db>.turso.io` + `TURSO_AUTH_TOKEN`
//! - Réplica embarcada:       `TURSO_SYNC_URL=libsql://...` + `TURSO_AUTH_TOKEN` (arquivo local sincronizado)
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
}

#[derive(Clone)]
pub struct Db {
    database: Arc<Database>,
    local: bool,
    pub info: DbInfo,
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
            (db, false, DbInfo { mode: "embedded-replica", location: format!("{local_path} ⇄ {sync}") })
        } else if let Some(u) = url.filter(|u| !u.starts_with("file:")) {
            let db = Builder::new_remote(u.clone(), token).build().await?;
            (db, false, DbInfo { mode: "remote", location: u })
        } else {
            if let Some(parent) = Path::new(&local_path).parent() {
                std::fs::create_dir_all(parent)?;
            }
            let db = Builder::new_local(&local_path).build().await?;
            (db, true, DbInfo { mode: "local", location: local_path })
        };

        let db = Db { database: Arc::new(database), local, info };
        let conn = db.conn().await?;
        if db.local {
            conn.query("PRAGMA journal_mode = WAL", ()).await?;
        }
        conn.execute_batch(MIGRATIONS).await?;
        db.migrate().await?;
        Ok(db)
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
