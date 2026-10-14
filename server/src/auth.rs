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
