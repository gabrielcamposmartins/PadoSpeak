//! Log em memória (buffer circular) exibido na página de hospedagem.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const MAX_LINES: usize = 500;

#[derive(Clone, Serialize)]
pub struct LogLine {
    pub id: u64,
    pub ts: i64,
    pub level: &'static str,
    pub text: String,
}

#[derive(Clone, Default)]
pub struct Logs {
    inner: Arc<Mutex<(u64, VecDeque<LogLine>)>>,
}

impl Logs {
    fn push(&self, level: &'static str, text: String) {
        eprintln!("[{}] {:5} {}", crate::now_ms(), level.to_uppercase(), text);
        let mut guard = self.inner.lock().unwrap();
        guard.0 += 1;
        let id = guard.0;
        guard.1.push_back(LogLine { id, ts: crate::now_ms(), level, text });
        if guard.1.len() > MAX_LINES {
            guard.1.pop_front();
        }
    }

    pub fn info(&self, text: impl Into<String>) {
        self.push("info", text.into());
    }
    pub fn warn(&self, text: impl Into<String>) {
        self.push("warn", text.into());
    }
    pub fn error(&self, text: impl Into<String>) {
        self.push("error", text.into());
    }

    pub fn since(&self, after: u64) -> Vec<LogLine> {
        let guard = self.inner.lock().unwrap();
        guard.1.iter().filter(|l| l.id > after).cloned().collect()
    }
}
