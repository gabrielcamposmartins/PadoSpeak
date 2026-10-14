//! Binário `padospeak-server`: painel de hospedagem + servidor de chat.
//!
//! - `padospeak-server`             abre o painel em http://127.0.0.1:3001 (botão "Hostear")
//! - `padospeak-server --host`      painel + servidor já no ar
//! - `padospeak-server --headless`  só o servidor (VM/Docker); painel só se `PANEL=true`
use padospeak_server::HostManager;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn truthy(v: Option<String>) -> Option<bool> {
    v.map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "padospeak-server [--host] [--headless] [--no-panel]\n\n\
             Variáveis: DATA_DIR, DATABASE_URL, TURSO_AUTH_TOKEN, TURSO_SYNC_URL, PORT, HOST, SERVER_NAME,\n\
             HTTPS (off|self-signed|custom), TLS_CERT, TLS_KEY, ICE_SERVERS (JSON), ALLOW_REGISTRATION,\n\
             AUTO_HOST, PANEL, PANEL_HOST, PANEL_PORT, PANEL_PASSWORD, LOCAL_NODE (nó local do app desktop)"
        );
        return;
    }
    let headless = args.iter().any(|a| a == "--headless");
    let auto_host = headless || args.iter().any(|a| a == "--host") || truthy(env("AUTO_HOST")).unwrap_or(false);
    let panel_enabled = !args.iter().any(|a| a == "--no-panel") && truthy(env("PANEL")).unwrap_or(!headless);

    let data_dir = env("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("data"));
    let local_node = truthy(env("LOCAL_NODE")).unwrap_or(false);
    let opened = if local_node { HostManager::new_local(data_dir).await } else { HostManager::new(data_dir).await };
    let host = match opened {
        Ok(h) => h,
        Err(e) => {
            eprintln!("Falha ao abrir o banco: {e}");
            std::process::exit(1);
        }
    };

    if auto_host {
        if let Err(e) = host.start(None).await {
            host.logs().error(format!("Não foi possível hostear: {e}"));
            if !panel_enabled {
                std::process::exit(1);
            }
        }
    }

    if panel_enabled {
        let password = env("PANEL_PASSWORD");
        let mut ip: IpAddr = env("PANEL_HOST").and_then(|h| h.parse().ok()).unwrap_or(IpAddr::from([127, 0, 0, 1]));
        if !ip.is_loopback() && password.is_none() {
            host.logs().warn("PANEL_HOST fora de loopback exige PANEL_PASSWORD; usando 127.0.0.1");
            ip = IpAddr::from([127, 0, 0, 1]);
        }
        let port = env("PANEL_PORT").and_then(|p| p.parse().ok()).unwrap_or(3001);
        let addr = SocketAddr::new(ip, port);
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                host.logs().info(format!("Painel de hospedagem: http://{addr}"));
                let router = padospeak_server::panel::router(host.clone(), password);
                tokio::spawn(async move {
                    let _ = axum::serve(listener, router).await;
                });
            }
            Err(e) => host.logs().error(format!("Painel não abriu em {addr}: {e}")),
        }
    }

    shutdown_signal().await;
    host.stop().await;
}

/// Ctrl+C no terminal ou SIGTERM (systemd/Docker).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
