//! Favoritas de cada pessoa e "Mais tocadas" de cada servidor (últimas 2 semanas).
use super::Track;
use crate::db::{Db, DbResult};
use serde_json::{json, Value};

/// Quanto tempo uma música tocada conta para "Mais tocadas".
const PLAYS_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
const TOP_LIMIT: i64 = 10;
const MAX_FAVORITES: i64 = 200;

/// Identidade de uma música: o link original sem parâmetros de rastreio (a mesma música adicionada
/// de novo cai na mesma chave). No YouTube só o `v=` importa.
pub fn track_key(page_url: &str) -> String {
    let url = page_url.trim();
    if let Some(id) = url.split(['?', '&']).find_map(|p| p.strip_prefix("v=")) {
        return format!("yt:{}", id.chars().take(16).collect::<String>());
    }
    if let Some(rest) = url.strip_prefix("https://youtu.be/") {
        return format!("yt:{}", rest.split(['?', '/']).next().unwrap_or(rest));
    }
    url.split('?').next().unwrap_or(url).trim_end_matches('/').to_string()
}

fn track_json(r: &libsql::Row) -> DbResult<Value> {
    Ok(json!({
        "key": r.get::<String>(0)?,
        "title": r.get::<String>(1)?,
        "artist": r.get::<Option<String>>(2)?,
        "pageUrl": r.get::<String>(3)?,
        "thumbnail": r.get::<Option<String>>(4)?,
        "durationMs": r.get::<Option<i64>>(5)?,
    }))
}

/// Registra que uma música começou a tocar no servidor (e descarta o que passou das 2 semanas).
pub async fn record_play(db: &Db, guild_id: &str, t: &Track) -> DbResult<()> {
    let now = crate::now_ms();
    db.execute("DELETE FROM music_plays WHERE played_at < ?1", [now - PLAYS_TTL_MS]).await?;
    db.execute(
        "INSERT INTO music_plays (guild_id, track_key, title, artist, page_url, thumbnail, duration_ms, played_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        libsql::params![
            guild_id,
            track_key(&t.page_url),
            t.title.as_str(),
            t.artist.clone(),
            t.page_url.as_str(),
            t.thumbnail.clone(),
            t.duration_ms.map(|d| d as i64),
            now
        ],
    )
    .await?;
    Ok(())
}

/// As 10 mais tocadas no servidor nas últimas 2 semanas (com quantas vezes tocaram).
pub async fn top(db: &Db, guild_id: &str) -> DbResult<Vec<Value>> {
    let since = crate::now_ms() - PLAYS_TTL_MS;
    db.query_all(
        "SELECT p.track_key, p.title, p.artist, p.page_url, p.thumbnail, p.duration_ms, t.n FROM music_plays p \
         JOIN (SELECT track_key, COUNT(*) AS n, MAX(played_at) AS last FROM music_plays \
               WHERE guild_id = ?1 AND played_at >= ?2 GROUP BY track_key) t \
           ON t.track_key = p.track_key AND p.played_at = t.last \
         WHERE p.guild_id = ?1 GROUP BY p.track_key ORDER BY t.n DESC, t.last DESC LIMIT ?3",
        libsql::params![guild_id, since, TOP_LIMIT],
        |r| {
            let mut v = track_json(r)?;
            v["plays"] = json!(r.get::<i64>(6)?);
            Ok(v)
        },
    )
    .await
}

pub async fn favorites(db: &Db, user_id: &str) -> DbResult<Vec<Value>> {
    db.query_all(
        "SELECT track_key, title, artist, page_url, thumbnail, duration_ms FROM music_favorites \
         WHERE user_id = ?1 ORDER BY created_at DESC",
        [user_id],
        track_json,
    )
    .await
}

/// Marca/desmarca uma favorita. `track` vem do cliente (título, artista, link, capa, duração).
pub async fn set_favorite(db: &Db, user_id: &str, track: &Value, on: bool) -> Result<(), String> {
    let page_url = track["pageUrl"].as_str().unwrap_or_default().trim();
    if !page_url.starts_with("https://") || page_url.len() > 500 {
        return Err("Música sem link".into());
    }
    let key = track_key(page_url);
    if !on {
        db.execute("DELETE FROM music_favorites WHERE user_id = ?1 AND track_key = ?2", [user_id, key.as_str()])
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let count = db
        .query_one("SELECT COUNT(*) FROM music_favorites WHERE user_id = ?1", [user_id], |r| r.get::<i64>(0))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if count >= MAX_FAVORITES {
        return Err(format!("Limite de {MAX_FAVORITES} favoritas"));
    }
    let text = |k: &str, max: usize| track[k].as_str().map(|s| s.chars().take(max).collect::<String>());
    let title = text("title", 200).filter(|t| !t.trim().is_empty()).ok_or("Música sem título")?;
    let thumb = text("thumbnail", 500).filter(|u| u.starts_with("https://"));
    db.execute(
        "INSERT INTO music_favorites (user_id, track_key, title, artist, page_url, thumbnail, duration_ms, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(user_id, track_key) DO NOTHING",
        libsql::params![user_id, key, title, text("artist", 200), page_url, thumb, track["durationMs"].as_i64(), crate::now_ms()],
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::track_key;

    #[test]
    fn mesma_musica_mesma_chave() {
        assert_eq!(track_key("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=2"), "yt:dQw4w9WgXcQ");
        assert_eq!(track_key("https://youtu.be/dQw4w9WgXcQ?si=abc"), "yt:dQw4w9WgXcQ");
        assert_eq!(
            track_key("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x"),
            "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
        );
    }
}
