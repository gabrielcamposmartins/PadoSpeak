//! Limite de tentativas de login: no máximo 5 erros seguidos para o mesmo usuário vindo do mesmo
//! endereço (e 20 de um mesmo endereço, somando usuários) a cada 15 minutos. Acertar a senha zera
//! a contagem daquele usuário.
use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

/// Erros permitidos por usuário + endereço dentro da janela.
pub const MAX_PER_USER: usize = 5;
/// Erros permitidos por endereço (tentando vários usuários) dentro da janela.
pub const MAX_PER_IP: usize = 20;
pub const WINDOW_MS: i64 = 15 * 60 * 1000;

#[derive(Default)]
pub struct LoginLimiter {
    fails: Mutex<HashMap<String, VecDeque<i64>>>,
}

pub static LOGIN: LazyLock<LoginLimiter> = LazyLock::new(LoginLimiter::default);

fn keys(ip: &str, user: &str) -> (String, String) {
    (format!("u:{ip}|{}", user.trim().to_lowercase()), format!("i:{ip}"))
}

impl LoginLimiter {
    /// `Err(ms)`: bloqueado; dá para tentar de novo depois desse tempo.
    pub fn check(&self, ip: &str, user: &str, now: i64) -> Result<(), i64> {
        let (uk, ik) = keys(ip, user);
        let mut map = self.fails.lock().unwrap();
        let mut wait = 0;
        for (key, max) in [(uk, MAX_PER_USER), (ik, MAX_PER_IP)] {
            if let Some(list) = map.get_mut(&key) {
                while list.front().is_some_and(|t| now - t >= WINDOW_MS) {
                    list.pop_front();
                }
                if list.is_empty() {
                    map.remove(&key);
                } else if list.len() >= max {
                    wait = wait.max(list[list.len() - max] + WINDOW_MS - now);
                }
            }
        }
        if wait > 0 { Err(wait) } else { Ok(()) }
    }

    /// Senha errada (ou usuário inexistente).
    pub fn fail(&self, ip: &str, user: &str, now: i64) {
        let (uk, ik) = keys(ip, user);
        let mut map = self.fails.lock().unwrap();
        for key in [uk, ik] {
            let list = map.entry(key).or_default();
            list.push_back(now);
            while list.len() > MAX_PER_IP {
                list.pop_front();
            }
        }
        // Não deixa a tabela crescer sem limite com endereços antigos.
        if map.len() > 50_000 {
            map.retain(|_, l| l.back().is_some_and(|t| now - t < WINDOW_MS));
        }
    }

    /// Quantos erros ainda faltam para bloquear esse usuário nesse endereço.
    pub fn remaining(&self, ip: &str, user: &str, now: i64) -> usize {
        let (uk, ik) = keys(ip, user);
        let map = self.fails.lock().unwrap();
        let used = |key: &str| map.get(key).map_or(0, |l| l.iter().filter(|t| now - **t < WINDOW_MS).count());
        MAX_PER_USER.saturating_sub(used(&uk)).min(MAX_PER_IP.saturating_sub(used(&ik)))
    }

    /// Entrou: zera os erros desse usuário nesse endereço.
    pub fn success(&self, ip: &str, user: &str) {
        let (uk, _) = keys(ip, user);
        self.fails.lock().unwrap().remove(&uk);
    }
}

/// "3 min", "1 min" (arredonda para cima).
pub fn wait_text(ms: i64) -> String {
    let min = ((ms + 59_999) / 60_000).max(1);
    format!("{min} min")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cinco_erros_bloqueiam_o_usuario() {
        let l = LoginLimiter::default();
        let t = 1_000_000;
        for i in 0..MAX_PER_USER {
            assert!(l.check("1.2.3.4", "Ana", t + i as i64).is_ok(), "tentativa {}", i + 1);
            l.fail("1.2.3.4", "ana", t + i as i64);
        }
        assert_eq!(l.remaining("1.2.3.4", "ana", t + 10), 0);
        assert_eq!(l.remaining("1.2.3.4", "bia", t + 10), MAX_PER_USER);
        let wait = l.check("1.2.3.4", "ANA", t + 10).unwrap_err();
        assert!(wait > 14 * 60 * 1000 && wait <= WINDOW_MS);
        // Outro endereço e outro usuário continuam podendo tentar.
        assert!(l.check("5.6.7.8", "ana", t + 10).is_ok());
        assert!(l.check("1.2.3.4", "bia", t + 10).is_ok());
        // Passada a janela, libera.
        assert!(l.check("1.2.3.4", "ana", t + WINDOW_MS + 5).is_ok());
    }

    #[test]
    fn acertar_zera_e_endereco_tem_limite_proprio() {
        let l = LoginLimiter::default();
        let t = 5_000_000;
        for _ in 0..4 {
            l.fail("9.9.9.9", "ana", t);
        }
        l.success("9.9.9.9", "ana");
        assert!(l.check("9.9.9.9", "ana", t).is_ok());
        for i in 0..MAX_PER_IP {
            l.fail("8.8.8.8", &format!("user{i}"), t);
        }
        assert!(l.check("8.8.8.8", "outro", t + 1).is_err(), "muitos usuários do mesmo endereço");
        assert_eq!(wait_text(61_000), "2 min");
    }
}
