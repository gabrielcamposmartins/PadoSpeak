// App desktop do PadoSpeak: o cliente (React) roda no WebView e o servidor Rust vem embutido duas vezes:
// - o **nó local**, sempre ligado: guarda o perfil deste PC (login offline) e conversa com a rede local;
// - o **servidor hospedado**, ligado pela página "Hostear" para receber outras pessoas.
// Fechar a janela só a esconde: o app continua na bandeja do Windows (perto do relógio), recebendo
// mensagens e chamadas. Para sair de verdade, botão direito no ícone → "Fechar o PadoSpeak".
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod screen_audio;

use padospeak_server::lan::Hosting;
use padospeak_server::logs::LogLine;
use padospeak_server::{HostConfig, HostManager, HostStatus};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_notification::NotificationExt;

type Host = Arc<HostManager>;
/// Nó local (tipo próprio para o Tauri distinguir do servidor hospedado).
struct Local(Arc<HostManager>);

/// Arquivo que marca que a pessoa já viu o aviso "continua aberto na bandeja".
struct TrayHint(PathBuf);

/// Iniciar com o Windows: arquivo com a escolha ("on"/"off") e se vale neste executável.
struct Autostart {
    choice: PathBuf,
    /// Só o app instalado de verdade mexe na inicialização (builds de teste/dev não).
    available: bool,
}

/// Argumento usado na entrada de inicialização: abre direto na bandeja, sem mostrar a janela.
const AUTOSTART_ARG: &str = "--autostart";

#[cfg(windows)]
mod startup {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "PadoSpeak";

    pub fn enabled() -> bool {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN).and_then(|k| k.get_value::<String, _>(NAME)).is_ok()
    }

    /// Liga (com o caminho atual do executável, que muda se o app for reinstalado) ou desliga.
    pub fn set(on: bool) -> std::io::Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN)?;
        if on {
            let exe = std::env::current_exe()?;
            key.set_value(NAME, &format!("\"{}\" {}", exe.display(), super::AUTOSTART_ARG))
        } else {
            match key.delete_value(NAME) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                r => r,
            }
        }
    }
}

#[cfg(not(windows))]
mod startup {
    pub fn enabled() -> bool {
        false
    }
    pub fn set(_on: bool) -> std::io::Result<()> {
        Ok(())
    }
}

/// Na primeira abertura liga o "iniciar com o Windows"; depois só reaplica a escolha (o caminho do
/// executável pode ter mudado numa atualização).
fn apply_autostart(cfg: &Autostart) {
    if !cfg.available {
        return;
    }
    let choice = std::fs::read_to_string(&cfg.choice).unwrap_or_default();
    let on = choice.trim() != "off";
    if choice.is_empty() {
        let _ = std::fs::write(&cfg.choice, "on");
    }
    if let Err(e) = startup::set(on) {
        eprintln!("iniciar com o Windows: {e}");
    }
}

/// Abre um endereço http(s) no navegador padrão (links das mensagens, baixar o instalador…).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("Endereço inválido".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // sem janela de console
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    std::process::Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn autostart_get(cfg: State<'_, Autostart>) -> Value {
    json!({ "available": cfg.available, "enabled": cfg.available && startup::enabled() })
}

#[tauri::command]
fn autostart_set(cfg: State<'_, Autostart>, on: bool) -> Result<bool, String> {
    if !cfg.available {
        return Err("Disponível só no app instalado".into());
    }
    startup::set(on).map_err(|e| e.to_string())?;
    std::fs::write(&cfg.choice, if on { "on" } else { "off" }).map_err(|e| e.to_string())?;
    Ok(startup::enabled())
}

/// Jogo em foco agora (o mesmo que vai no evento "activity").
#[tauri::command]
fn activity_get(watcher: State<'_, activity::Shared>) -> Option<activity::Activity> {
    watcher.current.lock().unwrap().clone()
}

/// Programas que a pessoa quer no status além dos jogos (Configurações → Atividade).
#[tauri::command]
fn activity_custom_set(watcher: State<'_, activity::Shared>, list: Vec<activity::Custom>) {
    watcher.set_custom(list);
}

/// Programas com janela aberta agora, para escolher qual entra no status.
#[tauri::command]
async fn activity_programs() -> Vec<activity::Program> {
    tauri::async_runtime::spawn_blocking(activity::programs).await.unwrap_or_default()
}

/// Portas tentadas para o nó local (a primeira livre vale).
const LOCAL_PORTS: std::ops::RangeInclusive<u16> = 47821..=47830;

#[tauri::command]
async fn host_status(host: State<'_, Host>) -> Result<HostStatus, String> {
    Ok(host.status().await)
}

/// Endereço que a rede local usa para entrar no servidor hospedado.
fn hosting_of(status: &HostStatus) -> Option<Hosting> {
    if !status.running {
        return None;
    }
    let url = status.urls.iter().find(|u| !u.contains("://localhost")).or(status.urls.first())?.clone();
    Some(Hosting { name: status.config.server_name.clone(), url })
}

#[tauri::command]
async fn host_start(host: State<'_, Host>, local: State<'_, Local>, config: HostConfig) -> Result<HostStatus, String> {
    let status = host.start(Some(config)).await?;
    local.0.set_lan_hosting(hosting_of(&status)).await;
    Ok(status)
}

#[tauri::command]
async fn host_stop(host: State<'_, Host>, local: State<'_, Local>) -> Result<HostStatus, String> {
    let status = host.stop().await;
    local.0.set_lan_hosting(None).await;
    Ok(status)
}

#[tauri::command]
fn host_logs(host: State<'_, Host>, after: u64) -> Vec<LogLine> {
    host.logs_since(after)
}

/// Onde o cliente encontra o nó local (perfil deste PC).
#[tauri::command]
async fn local_node(local: State<'_, Local>) -> Result<Value, String> {
    let status = local.0.status().await;
    if !status.running {
        return Err("O perfil local não iniciou. Veja se outro programa está usando as portas 47821–47830.".into());
    }
    Ok(json!({ "url": format!("http://localhost:{}", status.config.port), "port": status.config.port }))
}

/// Liga o nó local na primeira porta livre.
async fn start_local(local: &HostManager) -> Result<(), String> {
    let mut last = String::new();
    for port in LOCAL_PORTS {
        let cfg = HostConfig {
            server_name: "Perfil local".into(),
            port,
            host: "0.0.0.0".into(),
            allow_registration: true,
            ..HostConfig::default()
        };
        match local.start(Some(cfg)).await {
            Ok(_) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Traz a janela de volta (da bandeja ou do minimizado) para a frente.
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Notificação do Windows (pop-up na tela e na central de notificações). Clicar traz a janela de volta
/// e abre o lugar da notificação (`url`, ex.: `/?dm=<id>`). O som é o do próprio app (o do Messenger).
#[tauri::command]
fn notify_windows(app: AppHandle, title: String, body: String, url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Toast};
        // Instalado: o ID do app (o atalho do menu Iniciar registra o nome e o ícone). Rodando de
        // target/ (desenvolvimento), o Windows só mostra notificações com o ID do PowerShell.
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dev = exe.parent().is_some_and(|d| d.ends_with("target/debug") || d.ends_with("target/release"));
        let app_id = if dev { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
        let handle = app.clone();
        Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .sound(None)
            .duration(Duration::Short)
            .on_activated(move |_| {
                show_main(&handle);
                let _ = handle.emit("notification-open", url.clone());
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (app, title, body, url);
    Ok(())
}

/// Ícone na bandeja: clique abre a janela; botão direito tem "Abrir" e "Fechar o PadoSpeak".
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir o PadoSpeak", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Fechar o PadoSpeak", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("PadoSpeak")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Na primeira vez que a janela vai para a bandeja, explica onde o app ficou.
fn hint_tray_once(app: &AppHandle) {
    let path = app.state::<TrayHint>().0.clone();
    if path.exists() {
        return;
    }
    let _ = std::fs::write(&path, b"1");
    let _ = app
        .notification()
        .builder()
        .title("O PadoSpeak continua aberto")
        .body("Ele fica aqui na bandeja, perto do relógio, para você receber mensagens e chamadas. Para fechar de vez, clique com o botão direito no ícone.")
        .show();
}

fn main() {
    let app = tauri::Builder::default()
        // Abrir o app de novo (atalho, menu Iniciar) só mostra a janela que já está na bandeja.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // Banco Turso/libSQL e certificados ficam na pasta de dados do app (ou em DATA_DIR).
            let data_dir: std::path::PathBuf = match std::env::var("DATA_DIR") {
                Ok(dir) if !dir.is_empty() => dir.into(),
                _ => app.path().app_data_dir()?,
            };
            let host = tauri::async_runtime::block_on(HostManager::new(data_dir.clone())).map_err(|e| e.to_string())?;
            let local = tauri::async_runtime::block_on(HostManager::new_local(data_dir.join("perfil-local")))
                .map_err(|e| e.to_string())?;
            if let Err(e) = tauri::async_runtime::block_on(start_local(&local)) {
                local.logs().error(format!("Perfil local não iniciou: {e}"));
            }
            app.manage(host);
            app.manage(Local(local));
            app.manage(TrayHint(data_dir.join("aviso-bandeja")));
            let autostart = Autostart {
                choice: data_dir.join("iniciar-com-windows"),
                available: !cfg!(debug_assertions) && app.config().identifier == "dev.padospeak.desktop",
            };
            apply_autostart(&autostart);
            app.manage(autostart);
            app.manage(activity::spawn(app.handle().clone()));
            app.manage(screen_audio::ScreenAudio::default());
            build_tray(app)?;
            // Aberto pela inicialização do Windows: fica só na bandeja; senão mostra a janela.
            if !std::env::args().any(|a| a == AUTOSTART_ARG) {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fechar a janela principal a esconde na bandeja; sair é pelo menu do ícone.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    hint_tray_once(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![host_status, host_start, host_stop, host_logs, local_node, notify_windows, autostart_get, autostart_set, open_url, activity_get, activity_custom_set, activity_programs, screen_audio::screen_audio_start, screen_audio::screen_audio_stop])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o PadoSpeak");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let host = app.state::<Host>().inner().clone();
            let local = app.state::<Local>().0.clone();
            tauri::async_runtime::block_on(async {
                host.stop().await;
                local.stop().await;
            });
        }
    });
}
