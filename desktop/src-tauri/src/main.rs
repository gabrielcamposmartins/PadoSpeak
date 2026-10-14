// App desktop do PadoSpeak: o cliente (React) roda no WebView e o servidor Rust vem embutido duas vezes:
// - o **nó local**, sempre ligado: guarda o perfil deste PC (login offline) e conversa com a rede local;
// - o **servidor hospedado**, ligado pela página "Hostear" para receber outras pessoas.
// Fechar a janela só a esconde: o app continua na bandeja do Windows (perto do relógio), recebendo
// mensagens e chamadas. Para sair de verdade, botão direito no ícone → "Fechar o PadoSpeak".
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
            build_tray(app)?;
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
        .invoke_handler(tauri::generate_handler![host_status, host_start, host_stop, host_logs, local_node, notify_windows])
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
