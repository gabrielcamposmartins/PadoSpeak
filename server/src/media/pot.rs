//! Provedor de token do YouTube (PO token) do nó de mídia: o servidor do bgutil-ytdlp-pot-provider,
//! versão fixa, rodando no Deno, preso ao laço local (ele não tem autenticação: só o nó fala com ele).
//!
//! - `POT_PROVIDER_URL`: um provedor que já roda à parte (o contêiner `bgutil-ytdlp-pot-provider` do
//!   compose do nó, preso a `127.0.0.1:4416`).
//! - Sem ela: o nó baixa o código da versão fixa (conferindo o SHA-256) para `<data>/pot`, instala as
//!   dependências com o Deno (o mesmo que o yt-dlp usa) e sobe o servidor, supervisionado.
//!
//! O token sai da rede do nó; o servidor principal só repassa (`crate::music::pot`).
use crate::logs::Logs;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;

pub const VERSION: &str = crate::music::pot::PLUGIN_VERSION;
const SOURCE_URL: &str = "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/2.0.2.tar.gz";
const SOURCE_SHA256: &str = "1f2ae9ec39405b8e80397dfc2551f58deed09d8dff4b2b8fbc314df8e091c0a1";
const SOURCE_ROOT: &str = "bgutil-ytdlp-pot-provider-2.0.2/server/";
/// Instalar as dependências (jsdom, canvas, youtubei.js…) leva alguns minutos na primeira vez.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const START_TIMEOUT: Duration = Duration::from_secs(90);
const POT_TIMEOUT: Duration = Duration::from_secs(30);

/// O provedor de pé (o processo morre junto com este valor, se foi este nó que o subiu).
pub struct Provider {
    pub base: String,
    child: Option<tokio::process::Child>,
    /// Reaproveitado de uma execução anterior do nó (que caiu sem fechar o provedor): só a porta.
    port: Option<u16>,
}

impl Provider {
    /// O processo continua vivo (o externo, `POT_PROVIDER_URL`, conta sempre como vivo).
    pub fn alive(&mut self) -> bool {
        match (&mut self.child, self.port) {
            (Some(c), _) => matches!(c.try_wait(), Ok(None)),
            (None, Some(port)) => {
                std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
            }
            (None, None) => true,
        }
    }

    pub async fn get_pot(&self, http: &reqwest::Client, body: &Value) -> Value {
        let res = http.post(format!("{}/get_pot", self.base)).json(body).timeout(POT_TIMEOUT).send().await;
        match res {
            Ok(r) => r.json().await.unwrap_or_else(|e| json!({ "error": format!("resposta inválida do provedor: {e}") })),
            Err(e) => json!({ "error": format!("provedor de token: {e}") }),
        }
    }

    pub async fn ping(&self, http: &reqwest::Client) -> Value {
        match http.get(format!("{}/ping", self.base)).timeout(Duration::from_secs(5)).send().await {
            Ok(r) => r.json().await.unwrap_or(Value::Null),
            Err(e) => json!({ "error": e.to_string() }),
        }
    }
}

fn env_provider() -> Option<String> {
    std::env::var("POT_PROVIDER_URL").ok().map(|v| v.trim().trim_end_matches('/').to_string()).filter(|v| !v.is_empty())
}

/// Sobe (ou acha) o provedor. Pode levar minutos na primeira vez (download e instalação).
pub async fn launch(http: &reqwest::Client, data_dir: &Path, logs: &Logs) -> Result<Provider, String> {
    if let Some(base) = env_provider() {
        let p = Provider { base, child: None, port: None };
        let v = p.ping(http).await;
        if v.get("version").is_none() {
            logs.warn(format!("Token: o provedor em {} não respondeu ao ping ({v})", p.base));
        }
        return Ok(p);
    }
    let root = data_dir.join("pot");
    // O nó caiu sem fechar o provedor (morto à força, falta de energia): o que ficou de pé é reaproveitado,
    // em vez de subir outro ao lado.
    let saved = root.join("provider.json");
    if let Some(port) = std::fs::read_to_string(&saved).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["port"].as_u64()) {
        let old = Provider { base: format!("http://127.0.0.1:{port}"), child: None, port: Some(port as u16) };
        if old.ping(http).await.get("version").and_then(Value::as_str) == Some(VERSION) {
            logs.info(format!("Token: provedor bgutil {VERSION} de antes reaproveitado em {}", old.base));
            return Ok(old);
        }
    }
    let deno = crate::music::tools::deno(http, data_dir, logs).await.ok_or("o Deno não está disponível (nem para baixar)")?;
    let server = root.join(format!("bgutil-{VERSION}")).join("server");
    let cache = root.join("deno-cache");
    if !server.join("node_modules").is_dir() {
        install(http, &deno, &server, &cache, logs).await?;
    }
    let port = free_port().ok_or("sem porta livre no laço local")?;
    let mut cmd = crate::music::command(deno.as_os_str());
    cmd.current_dir(server.join("node_modules"))
        .env("DENO_DIR", &cache)
        .env("NO_COLOR", "1")
        .args(["run", "--allow-env", "--allow-net", "--allow-ffi=.", "--allow-read=.", "../src/main.ts", "--port"])
        .arg(port.to_string())
        .args(["--host", "127.0.0.1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("não deu para rodar o provedor: {e}"))?;
    for pipe in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)]
        .into_iter()
        .flatten()
    {
        let logs = logs.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if !line.is_empty() {
                    logs.info(format!("Token (bgutil): {}", line.chars().take(300).collect::<String>()));
                }
            }
        });
    }
    let provider = Provider { base: format!("http://127.0.0.1:{port}"), child: Some(child), port: Some(port) };
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        if provider.ping(http).await.get("version").is_some() {
            logs.info(format!("Token: provedor bgutil {VERSION} pronto em {}", provider.base));
            let _ = std::fs::write(&saved, json!({ "port": port }).to_string());
            return Ok(provider);
        }
        if tokio::time::Instant::now() > deadline {
            return Err("o provedor de token não respondeu a tempo".into());
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
}

/// Baixa o código fixo e instala as dependências com o Deno.
async fn install(http: &reqwest::Client, deno: &Path, server: &Path, cache: &Path, logs: &Logs) -> Result<(), String> {
    logs.info(format!("Token: preparando o provedor bgutil {VERSION} (só na primeira vez; pode levar alguns minutos)…"));
    let bytes = crate::music::tools::download_pinned(http, SOURCE_URL, SOURCE_SHA256).await?;
    let _ = std::fs::remove_dir_all(server);
    extract_server(&bytes, server)?;
    let mut cmd = crate::music::command(deno.as_os_str());
    cmd.current_dir(server)
        .env("DENO_DIR", cache)
        .env("NO_COLOR", "1")
        .args(["install", "--allow-scripts=npm:canvas", "--frozen"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let out = tokio::time::timeout(INSTALL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "a instalação do provedor demorou demais".to_string())?
        .map_err(|e| format!("deno install: {e}"))?;
    if !out.status.success() || !server.join("node_modules").is_dir() {
        let err = String::from_utf8_lossy(&out.stderr);
        let _ = std::fs::remove_dir_all(server.join("node_modules"));
        return Err(format!("deno install falhou: {}", err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("?").trim()));
    }
    Ok(())
}

/// Tira só a pasta `server/` do pacote, sem deixar nada sair dela.
fn extract_server(tar_gz: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tar_gz));
    let mut count = 0;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        let Some(rel) = path.strip_prefix(SOURCE_ROOT) else { continue };
        if rel.is_empty() || rel.split('/').any(|p| p == ".." || p.contains(':')) {
            continue;
        }
        let target: PathBuf = dest.join(rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else if entry.header().entry_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            entry.unpack(&target).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    if count == 0 || !dest.join("src").join("main.ts").is_file() {
        return Err("o pacote do provedor veio sem o servidor".into());
    }
    Ok(())
}

fn free_port() -> Option<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    l.local_addr().ok().map(|a| a.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrai_so_a_pasta_do_servidor() {
        let mut builder = tar::Builder::new(Vec::new());
        let add = |b: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8]| {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            h.set_cksum();
            b.append_data(&mut h, path, data).unwrap();
        };
        add(&mut builder, "bgutil-ytdlp-pot-provider-2.0.2/README.md", b"x");
        add(&mut builder, "bgutil-ytdlp-pot-provider-2.0.2/server/src/main.ts", b"console.log(1)");
        add(&mut builder, "bgutil-ytdlp-pot-provider-2.0.2/server/deno.lock", b"{}");
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar).unwrap();
        let bytes = gz.finish().unwrap();
        let dir = std::env::temp_dir().join(format!("padospeak-pot-{}", std::process::id()));
        extract_server(&bytes, &dir).unwrap();
        assert!(dir.join("src/main.ts").is_file());
        assert!(dir.join("deno.lock").is_file());
        assert!(!dir.join("README.md").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
