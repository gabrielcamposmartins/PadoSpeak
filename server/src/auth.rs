//! Senhas (bcrypt) e sessões opacas guardadas no banco.
use crate::db::{Db, DbResult};
use crate::models::{user_from_row, User, USER_COLS};

pub fn random_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

pub async fn hash_password(password: String) -> String {
    tokio::task::spawn_blocking(move || bcrypt::hash(password, 10).expect("bcrypt"))
        .await
        .expect("spawn_blocking")
}

pub async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false))
        .await
        .unwrap_or(false)
}

/// Código temporário legível (sem letras que confundem: 0/O, 1/I/L), no formato `ABCD-EFGH`.
fn temp_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    // bytes aleatórios do UUID v4 (o gerador seguro do sistema)
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut out = String::with_capacity(9);
    for (i, b) in bytes.iter().take(8).enumerate() {
        if i == 4 {
            out.push('-');
        }
        out.push(ALPHABET[*b as usize % ALPHABET.len()] as char);
    }
    out
}

/// Redefine a senha de `username`: a senha vira um código temporário (devolvido aqui), as sessões
/// abertas caem e, no próximo login com o código, a pessoa cria uma senha nova. `None` se o usuário
/// não existe.
pub async fn reset_password(db: &Db, username: &str) -> DbResult<Option<(String, String)>> {
    let Some((id, name)) = db
        .query_one("SELECT id, username FROM users WHERE username = ?1", [username.trim().trim_start_matches('@')], |r| {
            Ok((r.get::<String>(0)?, r.get::<String>(1)?))
        })
        .await?
    else {
        return Ok(None);
    };
    let code = temp_code();
    let hash = hash_password(code.clone()).await;
    db.execute("UPDATE users SET password_hash = ?1, must_reset = 1 WHERE id = ?2", (hash.as_str(), id.as_str())).await?;
    db.execute("DELETE FROM sessions WHERE user_id = ?1", [id.as_str()]).await?;
    Ok(Some((name, code)))
}

pub async fn create_session(db: &Db, user_id: &str) -> DbResult<String> {
    let token = random_token();
    db.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?1, ?2, ?3)",
        (token.as_str(), user_id, crate::now_ms()),
    )
    .await?;
    Ok(token)
}

pub async fn user_from_token(db: &Db, token: &str) -> Option<User> {
    if token.is_empty() {
        return None;
    }
    let sql = format!("SELECT {USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1");
    db.query_one(&sql, [token], user_from_row).await.ok().flatten()
}
