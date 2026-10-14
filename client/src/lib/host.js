// Controle do servidor local para a página "Hostear".
// - App desktop (Tauri): comandos Rust que chamam o HostManager embutido no próprio app.
// - Painel do padospeak-server (VM/headless): rotas HTTP /panel-api/* do binário.
import { isTauri, isPanel } from './env.js';

export const canHost = isTauri || isPanel;

async function tauri(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e?.message || 'Erro');
  }
}

async function panel(method, path, body) {
  const res = await fetch(`/panel-api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

export const host = {
  status: () => (isTauri ? tauri('host_status') : panel('GET', 'status')),
  start: (config) => (isTauri ? tauri('host_start', { config }) : panel('POST', 'start', config)),
  stop: () => (isTauri ? tauri('host_stop') : panel('POST', 'stop')),
  logs: (after = 0) => (isTauri ? tauri('host_logs', { after }) : panel('GET', `logs?after=${after}`)),
};
