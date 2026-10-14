//! HTTPS: certificado autoassinado (gerado em `<data_dir>/tls`) ou certificado próprio.
//!
//! Navegadores só liberam câmera, microfone e captura de tela em contexto seguro
//! (HTTPS ou localhost). O app desktop não precisa disso; o acesso pelo navegador via
//! IP da LAN/VM precisa.
use crate::config::{HostConfig, HttpsMode};
use std::net::IpAddr;
use std::path::Path;

/// IPv4 da máquina na rede, com placas físicas antes das virtuais (WSL, Hyper-V, Docker, VMs).
pub fn lan_addresses() -> Vec<IpAddr> {
    const VIRTUAL: [&str; 8] = ["vethernet", "wsl", "hyper-v", "docker", "virtualbox", "vmware", "veth", "br-"];
    let mut list: Vec<(bool, IpAddr)> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, ip)| match ip {
            IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified(),
            IpAddr::V6(_) => false,
        })
        .map(|(name, ip)| {
            let name = name.to_lowercase();
            (VIRTUAL.iter().any(|v| name.contains(v)), ip)
        })
        .collect();
    list.sort_by_key(|(is_virtual, _)| *is_virtual);
    list.into_iter().map(|(_, ip)| ip).collect()
}

/// Retorna `(cert_pem, key_pem)` ou `None` quando o HTTPS está desligado.
pub fn resolve(cfg: &HostConfig, data_dir: &Path) -> Result<Option<(Vec<u8>, Vec<u8>)>, String> {
    match cfg.https {
        HttpsMode::Off => Ok(None),
        HttpsMode::Custom => {
            let cert = std::fs::read(&cfg.tls_cert).map_err(|e| format!("Certificado {}: {e}", cfg.tls_cert))?;
            let key = std::fs::read(&cfg.tls_key).map_err(|e| format!("Chave {}: {e}", cfg.tls_key))?;
            Ok(Some((cert, key)))
        }
        HttpsMode::SelfSigned => self_signed(data_dir).map(Some),
    }
}

fn self_signed(data_dir: &Path) -> Result<(Vec<u8>, Vec<u8>), String> {
    let dir = data_dir.join("tls");
    let cert_file = dir.join("selfsigned.crt");
    let key_file = dir.join("selfsigned.key");
    let hosts_file = dir.join("hosts.txt");

    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    names.extend(lan_addresses().iter().map(IpAddr::to_string));
    let hosts_key = names.join(",");

    // Reaproveita o certificado enquanto os IPs da máquina não mudarem.
    if let (Ok(cert), Ok(key), Ok(hosts)) =
        (std::fs::read(&cert_file), std::fs::read(&key_file), std::fs::read_to_string(&hosts_file))
    {
        if hosts == hosts_key {
            return Ok((cert, key));
        }
    }

    let generated = rcgen::generate_simple_self_signed(names).map_err(|e| format!("rcgen: {e}"))?;
    let cert = generated.cert.pem().into_bytes();
    let key = generated.signing_key.serialize_pem().into_bytes();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&cert_file, &cert).map_err(|e| e.to_string())?;
    std::fs::write(&key_file, &key).map_err(|e| e.to_string())?;
    std::fs::write(&hosts_file, hosts_key).map_err(|e| e.to_string())?;
    Ok((cert, key))
}
