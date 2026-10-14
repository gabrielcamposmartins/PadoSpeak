// App desktop do PadoSpeak: o cliente (React) roda no WebView e o servidor Rust vem embutido duas vezes:
// - o **nó local**, sempre ligado: guarda o perfil deste PC (login offline) e conversa com a rede local;
// - o **servidor hospedado**, ligado pela página "Hostear" para receber outras pessoas.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use padospeak_server::lan::Hosting;
use padospeak_server::logs::LogLine;
use padospeak_server::{HostConfig, HostManager, HostStatus};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Manager, RunEvent, State};

type Host = Arc<HostManager>;
/// Nó local (tipo próprio para o Tauri distinguir do servidor hospedado).
struct Local(Arc<HostManager>);

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

fn main() {
    let app = tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![host_status, host_start, host_stop, host_logs, local_node])
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
