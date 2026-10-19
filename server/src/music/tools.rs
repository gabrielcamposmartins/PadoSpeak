//! Localiza (ou baixa) o yt-dlp e um runtime JavaScript — o YouTube exige um para o yt-dlp funcionar.
//!
//! yt-dlp:  `YTDLP_PATH` → PATH → `<data>/bin` → GitHub Releases → PyPI (se houver Python)
//! JS:      `YTDLP_JS_RUNTIME` → deno/node no PATH → `<data>/bin/deno` → pacote oficial do Deno no npm
//!
//! Várias fontes porque algumas redes bloqueiam o GitHub.
use crate::logs::Logs;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::Semaphore;

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

/// Um yt-dlp por vez: cada um, com o runtime JS, ocupa 100 MB ou mais, e na VM pequena dois juntos
/// encostavam o servidor no limite de memória (a sinalização das chamadas atrasava junto).
static SLOT: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

/// Como invocar o yt-dlp (binário próprio ou `python -m yt_dlp`).
#[derive(Clone, Debug)]
pub struct Tools {
    program: PathBuf,
    prefix: Vec<OsString>,
    envs: Vec<(String, OsString)>,
    /// Valor de `--js-runtimes` (ex.: `node` ou `deno:C:\...\deno.exe`).
    js_runtime: Option<String>,
    /// `--cookies arquivo` / `--cookies-from-browser navegador`, quando o host configurou.
    cookies: Vec<String>,
    /// Índice da variante (ver `VARIANTS`) que funcionou por último.
    preferred: Arc<AtomicUsize>,
    /// Pasta temporária só do yt-dlp. A versão "um arquivo só" se descompacta nela a cada execução, e
    /// as que estouram o tempo deixam a cópia (80 MB) para trás: aqui dá para limpar sem mexer nos
    /// temporários de outros programas.
    tmp: Option<PathBuf>,
}

/// Variantes tentadas quando o YouTube bloqueia (anti-robô): família de IP × cliente do player.
/// O bloqueio costuma ser por IP — muitas vezes o IPv6 passa quando o IPv4 foi marcado — e o
/// cliente `web_embedded` costuma passar para vídeos incorporáveis.
const VARIANTS: [(Option<&str>, Option<&str>); 4] = [
    (None, None),
    (None, Some("web_embedded")),
    (Some("-4"), None),
    (Some("-4"), Some("web_embedded")),
];

/// Erros que indicam bloqueio do YouTube (vale tentar outra variante), e não vídeo indisponível.
fn is_blocked(stderr: &str) -> bool {
    ["not a bot", "Sign in to confirm", "page needs to be reloaded", "Requested format is not available", "HTTP Error 429"]
        .iter()
        .any(|m| stderr.contains(m))
}

fn last_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .unwrap_or("vídeo indisponível")
        .trim_start_matches("ERROR: ")
        .to_string()
}

impl Tools {
    /// Comando base do yt-dlp (runtime JS, cookies e sem avisos).
    pub fn ytdlp(&self) -> tokio::process::Command {
        let mut cmd = super::command(self.program.as_os_str());
        cmd.args(&self.prefix).envs(self.envs.iter().map(|(k, v)| (k, v)));
        if let Some(tmp) = &self.tmp {
            cmd.env("TMPDIR", tmp).env("TEMP", tmp).env("TMP", tmp);
        }
        cmd.args(["--no-warnings", "--no-progress"]).args(&self.cookies);
        if let Some(js) = &self.js_runtime {
            cmd.args(["--js-runtimes", js]);
        }
        cmd
    }

    pub fn set_cookies(&mut self, file: &str, browser: &str) {
        self.cookies.clear();
        if !file.trim().is_empty() {
            self.cookies.extend(["--cookies".into(), file.trim().into()]);
        } else if !browser.trim().is_empty() {
            self.cookies.extend(["--cookies-from-browser".into(), browser.trim().into()]);
        }
    }

    /// Roda o yt-dlp e devolve o stdout. Se o YouTube bloquear, tenta as outras variantes
    /// (começando pela que funcionou da última vez).
    pub async fn run(&self, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
        let start = self.preferred.load(Ordering::Relaxed);
        let mut last = String::new();
        for i in 0..VARIANTS.len() {
            let idx = (start + i) % VARIANTS.len();
            let (family, client) = VARIANTS[idx];
            let mut cmd = self.ytdlp();
            if let Some(f) = family {
                cmd.arg(f);
            }
            if let Some(c) = client {
                cmd.args(["--extractor-args", &format!("youtube:player_client={c}")]);
            }
            cmd.args(args);
            let out = self.output(cmd, timeout).await?;
            if out.status.success() {
                self.preferred.store(idx, Ordering::Relaxed);
                return Ok(out.stdout);
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            last = last_error(&stderr);
            if !is_blocked(&stderr) {
                return Err(last);
            }
        }
        if self.cookies.is_empty() {
            Err("o YouTube bloqueou temporariamente este servidor (verificação anti-robô). O host pode configurar cookies em Hostear → Música.".into())
        } else {
            Err(format!("o YouTube recusou mesmo com cookies: {last}"))
        }
    }

    /// Como `run`, mas com um cliente do YouTube escolhido (`player_client`): só alterna IPv4/IPv6
    /// se o YouTube bloquear.
    pub async fn run_client(&self, client: &str, args: &[&str], timeout: Duration) -> Result<Vec<u8>, String> {
        let mut last = String::new();
        for family in [None, Some("-4")] {
            let mut cmd = self.ytdlp();
            if let Some(f) = family {
                cmd.arg(f);
            }
            cmd.args(["--extractor-args", &format!("youtube:player_client={client}")]).args(args);
            let out = self.output(cmd, timeout).await?;
            if out.status.success() {
                return Ok(out.stdout);
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            last = last_error(&stderr);
            if !is_blocked(&stderr) {
                break;
            }
        }
        Err(last)
    }

    /// Roda um yt-dlp na sua vez (veja `SLOT`). A espera pela vez também conta no tempo.
    async fn output(&self, mut cmd: tokio::process::Command, timeout: Duration) -> Result<std::process::Output, String> {
        let deadline = tokio::time::Instant::now() + timeout;
        let _vez = tokio::time::timeout_at(deadline, SLOT.acquire())
            .await
            .map_err(|_| "o servidor está ocupado buscando outras músicas; tente de novo daqui a pouco".to_string())?
            .map_err(|_| "yt-dlp indisponível".to_string())?;
        match tokio::time::timeout_at(deadline, cmd.output()).await {
            Ok(out) => out.map_err(|e| format!("yt-dlp: {e}")),
            Err(_) => {
                // Morto no meio: a cópia descompactada fica para trás.
                if let Some(tmp) = &self.tmp {
                    sweep_extractions(tmp);
                }
                Err("o YouTube demorou demais para responder".into())
            }
        }
    }

    pub fn describe(&self) -> String {
        let prog = self.program.display();
        let js = self.js_runtime.as_deref().unwrap_or("nenhum");
        if self.prefix.is_empty() { format!("{prog} (JS: {js})") } else { format!("{prog} -m yt_dlp (JS: {js})") }
    }
}

/// Apaga as cópias descompactadas (`_MEI…`) que o yt-dlp deixou na pasta temporária dele.
fn sweep_extractions(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with("_MEI") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Procura um executável no PATH (respeitando as extensões do Windows).
pub fn which(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        env("PATHEXT").unwrap_or(".EXE;.CMD;.BAT".into()).split(';').map(|e| e.to_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|p| p.is_file())
    })
}

async fn runs(program: &Path, args: &[&str], envs: &[(String, OsString)]) -> bool {
    let mut cmd = super::command(program.as_os_str());
    cmd.args(args).envs(envs.iter().map(|(k, v)| (k, v))).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    matches!(tokio::time::timeout(Duration::from_secs(60), cmd.status()).await, Ok(Ok(s)) if s.success())
}

async fn download(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let res = http.get(url).timeout(Duration::from_secs(300)).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}: HTTP {}", res.status()));
    }
    Ok(res.bytes().await.map_err(|e| format!("{url}: {e}"))?.to_vec())
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn ytdlp_asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("yt-dlp.exe"),
        ("windows", "aarch64") => Some("yt-dlp_arm64.exe"),
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        ("macos", _) => Some("yt-dlp_macos"),
        _ => None,
    }
}

fn deno_npm_package() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("linux", "x86_64") => Some("linux-x64-glibc"),
        ("linux", "aarch64") => Some("linux-arm64-glibc"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        _ => None,
    }
}

async fn find_ytdlp(http: &reqwest::Client, bin: &Path, data_dir: &Path, logs: &Logs) -> Result<Tools, String> {
    let plain = |program: PathBuf| Tools {
        program,
        prefix: vec![],
        envs: vec![],
        js_runtime: None,
        cookies: vec![],
        preferred: Default::default(),
        tmp: None,
    };

    if let Some(p) = env("YTDLP_PATH") {
        return Ok(plain(p.into()));
    }
    if let Some(p) = which("yt-dlp") {
        return Ok(plain(p));
    }
    let local = bin.join(format!("yt-dlp{EXE}"));
    if local.is_file() {
        return Ok(plain(local));
    }

    // GitHub Releases (binário autocontido)
    if let Some(asset) = ytdlp_asset() {
        let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}");
        logs.info(format!("Música: baixando yt-dlp ({url})…"));
        match download(http, &url).await {
            Ok(bytes) => {
                write_executable(&local, &bytes)?;
                return Ok(plain(local));
            }
            Err(e) => logs.warn(format!("Música: download do yt-dlp pelo GitHub falhou ({e}); tentando pelo PyPI")),
        }
    }

    // PyPI (precisa de Python 3 instalado)
    let python = ["python", "python3", "py"].into_iter().find_map(which);
    let Some(python) = python else {
        return Err("yt-dlp não encontrado e o GitHub está inacessível. Instale o yt-dlp (ou Python 3) ou defina YTDLP_PATH.".into());
    };
    let target = data_dir.join("py");
    logs.info(format!("Música: instalando yt-dlp pelo PyPI em {}…", target.display()));
    let target_s = target.to_string_lossy().into_owned();
    let pip = ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--upgrade", "--target", &target_s, "yt-dlp[default]"];
    if !runs(&python, &pip, &[]).await {
        return Err("Falha ao instalar o yt-dlp pelo pip".into());
    }
    Ok(Tools {
        program: python,
        prefix: vec!["-m".into(), "yt_dlp".into()],
        envs: vec![("PYTHONPATH".into(), target.into_os_string())],
        js_runtime: None,
        cookies: vec![],
        preferred: Default::default(),
        tmp: None,
    })
}

async fn find_js_runtime(http: &reqwest::Client, bin: &Path, logs: &Logs) -> Option<String> {
    if let Some(v) = env("YTDLP_JS_RUNTIME") {
        return Some(v);
    }
    if which("deno").is_some() {
        return Some("deno".into());
    }
    if which("node").is_some() {
        return Some("node".into());
    }
    let local = bin.join(format!("deno{EXE}"));
    if !local.is_file() {
        let pkg = deno_npm_package()?;
        // O Deno publica binários oficiais no npm como @deno/<plataforma>.
        let meta_url = format!("https://registry.npmjs.org/@deno/{pkg}/latest");
        logs.info(format!("Música: baixando Deno (@deno/{pkg} do npm)…"));
        let tarball = async {
            let meta: serde_json::Value = serde_json::from_slice(&download(http, &meta_url).await?).map_err(|e| e.to_string())?;
            let url = meta["dist"]["tarball"].as_str().ok_or("tarball ausente")?.to_string();
            download(http, &url).await
        };
        let bytes = match tarball.await {
            Ok(b) => b,
            Err(e) => {
                logs.warn(format!("Música: não foi possível baixar o Deno ({e})"));
                return None;
            }
        };
        let exe = format!("package/deno{EXE}");
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(&bytes[..]));
        let mut found = None;
        for entry in archive.entries().ok()? {
            let mut entry = entry.ok()?;
            if entry.path().ok()?.to_string_lossy() == exe {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut buf).ok()?;
                found = Some(buf);
                break;
            }
        }
        let Some(buf) = found else {
            logs.warn("Música: binário do Deno não encontrado no pacote do npm");
            return None;
        };
        if let Err(e) = write_executable(&local, &buf) {
            logs.warn(format!("Música: falha ao salvar o Deno: {e}"));
            return None;
        }
    }
    Some(format!("deno:{}", local.display()))
}

/// Garante as ferramentas (pode baixar dezenas de MB na primeira vez).
pub async fn provision(http: &reqwest::Client, data_dir: &Path, logs: &Logs) -> Result<Tools, String> {
    let bin = data_dir.join("bin");
    let mut tools = find_ytdlp(http, &bin, data_dir, logs).await?;
    tools.js_runtime = find_js_runtime(http, &bin, logs).await;
    // Pasta temporária própria, começando vazia (sobras de execuções interrompidas antes de reiniciar).
    let tmp = data_dir.join("tmp").join("yt-dlp");
    let _ = std::fs::remove_dir_all(&tmp);
    if std::fs::create_dir_all(&tmp).is_ok() {
        tools.tmp = Some(tmp);
    }
    if tools.js_runtime.is_none() {
        logs.warn("Música: nenhum runtime JavaScript (Deno/Node) — o YouTube pode recusar parte dos vídeos");
    }
    let mut check = tools.ytdlp();
    check.arg("--version").stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(60), check.output()).await;
    match out {
        Ok(Ok(o)) if o.status.success() => {
            logs.info(format!(
                "Música: yt-dlp {} pronto — {}",
                String::from_utf8_lossy(&o.stdout).trim(),
                tools.describe()
            ));
            Ok(tools)
        }
        _ => Err(format!("yt-dlp não executou ({})", tools.describe())),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_blocked, last_error, sweep_extractions};

    #[test]
    fn limpa_so_as_copias_do_yt_dlp() {
        let dir = std::env::temp_dir().join(format!("padospeak-teste-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("_MEIabc123/lib")).unwrap();
        std::fs::write(dir.join("_MEIabc123/lib/x.so"), b"x").unwrap();
        std::fs::write(dir.join("cookies.txt"), b"c").unwrap();
        sweep_extractions(&dir);
        assert!(!dir.join("_MEIabc123").exists());
        assert!(dir.join("cookies.txt").exists(), "outros arquivos ficam");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn distingue_bloqueio_de_video_indisponivel() {
        assert!(is_blocked("ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies"));
        assert!(is_blocked("ERROR: [youtube] x: The page needs to be reloaded."));
        assert!(!is_blocked("ERROR: [youtube] x: Video unavailable. This video is private"));
        assert_eq!(last_error("WARNING: a\nERROR: [youtube] x: Video unavailable"), "[youtube] x: Video unavailable");
    }
}
