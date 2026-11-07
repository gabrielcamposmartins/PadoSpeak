//! Nó de mídia deste PC (Hostear → Nó de mídia): o SFU das chamadas e o token da música de um servidor
//! do PadoSpeak, rodando dentro do app (veja `padospeak_server::media::node`).
//!
//! O código de pareamento e a porta ficam em `<dados>/no-de-midia.json`: ligado uma vez, o nó volta sozinho
//! quando o app abre. Não sobe o nó local nem mexe na rede local: ele só liga para o servidor.
use padospeak_server::logs::{LogLine, Logs};
use padospeak_server::media::node::{MediaNode, NodeConfig};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct MediaNodeSlot {
    node: Mutex<Option<Arc<MediaNode>>>,
    dir: PathBuf,
    file: PathBuf,
    logs: Logs,
}

impl MediaNodeSlot {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            node: Mutex::new(None),
            dir: data_dir.join("no-de-midia"),
            file: data_dir.join("no-de-midia.json"),
            logs: Logs::default(),
        }
    }

    fn saved(&self) -> Value {
        std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
    }

    fn save(&self, v: &Value) {
        let _ = std::fs::write(&self.file, v.to_string());
    }

    fn start(&self, code: &str, port: Option<u16>) -> Result<(), String> {
        let mut slot = self.node.lock().unwrap();
        if let Some(old) = slot.take() {
            old.stop();
        }
        let cfg = NodeConfig::new(code, port, self.dir.clone())?;
        *slot = Some(MediaNode::start(cfg, self.logs.clone())?);
        Ok(())
    }

    /// O app abriu: o nó volta se estava ligado.
    pub fn resume(&self) {
        let saved = self.saved();
        if saved["on"] != true {
            return;
        }
        let Some(code) = saved["code"].as_str() else { return };
        let port = saved["udpPort"].as_u64().map(|p| p as u16);
        if let Err(e) = self.start(code, port) {
            self.logs.error(format!("Nó de mídia não voltou: {e}"));
        }
    }

    fn view(&self) -> Value {
        let saved = self.saved();
        let status = self.node.lock().unwrap().as_ref().map(|n| n.status());
        json!({
            "status": status,
            "hasCode": saved["code"].is_string(),
            "udpPort": saved["udpPort"],
            "on": saved["on"] == true,
        })
    }
}

#[tauri::command]
pub fn media_node_status(slot: State<'_, MediaNodeSlot>) -> Value {
    slot.view()
}

/// Liga o nó. `code` vazio: usa o código guardado.
#[tauri::command]
pub async fn media_node_start(slot: State<'_, MediaNodeSlot>, code: String, udp_port: Option<u16>) -> Result<Value, String> {
    let saved = slot.saved();
    let code = if code.trim().is_empty() { saved["code"].as_str().unwrap_or_default().to_string() } else { code.trim().to_string() };
    if code.is_empty() {
        return Err("Cole o código do nó (Painel → Mídia → Adicionar nó, no servidor)".into());
    }
    let port = udp_port.or(saved["udpPort"].as_u64().map(|p| p as u16));
    slot.start(&code, port)?;
    slot.save(&json!({ "code": code, "udpPort": port, "on": true }));
    Ok(slot.view())
}

#[tauri::command]
pub fn media_node_stop(slot: State<'_, MediaNodeSlot>) -> Value {
    if let Some(node) = slot.node.lock().unwrap().take() {
        node.stop();
    }
    let mut saved = slot.saved();
    if saved.is_object() {
        saved["on"] = json!(false);
        slot.save(&saved);
    }
    slot.view()
}

/// Esquece o código guardado (e desliga o nó).
#[tauri::command]
pub fn media_node_forget(slot: State<'_, MediaNodeSlot>) -> Value {
    if let Some(node) = slot.node.lock().unwrap().take() {
        node.stop();
    }
    let _ = std::fs::remove_file(&slot.file);
    slot.view()
}

#[tauri::command]
pub fn media_node_logs(slot: State<'_, MediaNodeSlot>, after: u64) -> Vec<LogLine> {
    slot.logs.since(after)
}
