// App do Android (pasta `android/`, MainActivity.kt e Bridge.kt): a página conversa com o app pela ponte
// `PadoSpeakAndroid.postMessage(JSON)` e recebe o evento `padospeak:android`. O app cuida do que é do sistema:
//  - notificações quando o app não está na tela (mensagens e chamada recebida, com Atender/Recusar);
//  - a chamada que continua com a tela apagada (serviço com a notificação "Em chamada" e "Sair da chamada");
//  - downloads (anexos pelo gerenciador de downloads; arquivos gerados aqui, em pedaços);
//  - cores das barras do sistema (systemBars.js) e links de fora no navegador (env.js).
import { useSyncExternalStore } from 'react';
import { isAndroidApp } from './env.js';

let visible = true;
const handlers = new Map(); // tipo -> Set de funções

/** Manda uma mensagem ao app (no navegador, não faz nada). */
export function androidPost(type, data = {}) {
  if (!isAndroidApp || !window.PadoSpeakAndroid) return false;
  try {
    window.PadoSpeakAndroid.postMessage(JSON.stringify({ type, ...data }));
    return true;
  } catch (e) {
    console.warn('[android]', e);
    return false;
  }
}

/** O app está na tela agora (não está em segundo plano nem com a tela apagada)? */
export const androidVisible = () => visible && !document.hidden;

/** Recebe as mensagens do app de um tipo ('open', 'leaveCall', 'visible'…). */
export function onAndroid(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}

const CHUNK = 512 * 1024;

/** Salva um arquivo gerado na página (blob) em Downloads, mandando os bytes ao app em pedaços. */
export async function androidSaveBlob(blob, name) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const mime = blob.type || 'application/octet-stream';
  for (let at = 0; ; at += CHUNK) {
    const part = blob.slice(at, at + CHUNK);
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(part);
    });
    const last = at + CHUNK >= blob.size;
    androidPost('blob', { id, name, mime, data, last });
    if (last) break;
  }
}

if (isAndroidApp && typeof window !== 'undefined') {
  window.addEventListener('padospeak:android', (e) => {
    const d = e.detail || {};
    if (d.type === 'visible') visible = Boolean(d.value);
    handlers.get(d.type)?.forEach((fn) => {
      try {
        fn(d);
      } catch (err) {
        console.warn('[android]', err);
      }
    });
  });
  // Links com `download` que a página não tratou (o app pede os bytes de volta por aqui).
  window.__padospeakSaveBlob = (blob, name) => androidSaveBlob(blob, name).catch((err) => console.warn('[download]', err));
}

// ---------- Diagnóstico: o que pode estar impedindo os avisos ----------
let status = null;
const statusSubs = new Set();
if (isAndroidApp && typeof window !== 'undefined') {
  window.addEventListener('padospeak:android', (e) => {
    if (e.detail?.type !== 'status') return;
    status = e.detail;
    statusSubs.forEach((f) => f());
  });
}

/** Estado das permissões do app ({ notifications, battery, fullScreen, connected, version } ou null). */
export function useAndroidStatus() {
  return useSyncExternalStore(
    (f) => {
      statusSubs.add(f);
      androidPost('status');
      return () => statusSubs.delete(f);
    },
    () => status,
    () => null,
  );
}

/** Abre a tela do Android que libera o que falta (`notifications`, `battery`, `fullScreen`). */
export const androidFix = (what) => androidPost('fix', { what });

const KEEP_KEY = 'padospeak.androidKeepAlive';

/** "Receber chamadas e mensagens com o app em segundo plano" (neste celular; ligado por padrão). */
export function androidKeepAlive() {
  try {
    return localStorage.getItem(KEEP_KEY) !== '0';
  } catch {
    return true;
  }
}

let syncSession = () => {};

export function setAndroidKeepAlive(on) {
  try {
    localStorage.setItem(KEEP_KEY, on ? '1' : '0');
  } catch {
    /* sem armazenamento: vale só até fechar */
  }
  syncSession(true);
}

/** Canal ou conversa de um endereço de notificação (`/?dm=…` ou `/?channel=…`) e a conexão dele. */
function targetOf(connRegistry, url) {
  const q = new URL(url, location.origin).searchParams;
  const dm = q.get('dm');
  const channel = q.get('channel');
  for (const c of connRegistry.values()) {
    const s = c.getState();
    if (dm && s.dms?.some((d) => d.id === dm)) return { store: c, channelId: dm };
    if (channel && Object.values(s.guildData || {}).some((g) => g.channels?.some((ch) => ch.id === channel))) return { store: c, channelId: channel };
  }
  return null;
}

/**
 * Liga a ponte depois que o app (store) existe: abre o lugar das notificações, sai da chamada e responde
 * mensagens pelos botões das notificações, e conta ao app (na hora, sem esperar timer — em segundo plano o
 * navegador atrasa os timers) quando há chamada, quando alguém está chamando e se há conta conectada.
 */
export function initAndroid({ connRegistry, openFromUrl, useStore, networkChanged }) {
  if (!isAndroidApp) return;
  onAndroid('open', (d) => d.url && openFromUrl(d.url));
  onAndroid('leaveCall', () => {
    for (const c of connRegistry.values()) if (c.getState().voice) c.getState().leaveVoice();
  });
  onAndroid('reply', async (d) => {
    const text = String(d.text || '').trim();
    const target = text && d.url ? targetOf(connRegistry, d.url) : null;
    const ok = target ? await target.store.getState().sendMessage(target.channelId, text) : false;
    androidPost('replied', { url: d.url, ok: Boolean(ok), text });
  });
  // Rede voltou ou mudou (Wi-Fi ↔ dados): reconecta já.
  onAndroid('online', () => networkChanged());

  let lastCall = '';
  let lastRing = '';
  let lastSession = '';
  // O app já liga a conexão em segundo plano ao abrir (se a opção estiver ligada); aqui ele fica sabendo se
  // há conta conectada e guarda a escolha da pessoa.
  syncSession = (force = false) => {
    const keepAlive = androidKeepAlive();
    const logged = [...connRegistry.values()].some((c) => c.getState().me);
    // Ainda carregando a conta (abriu agora, voltou depois de cair): fica como o app abriu, sem desligar
    // para religar logo depois (o Android não deixa religar com o app fora da tela).
    if (!logged && useStore.getState().phase !== 'auth' && !force) return;
    const on = logged && keepAlive;
    const key = `${on}|${keepAlive}`;
    if (key === lastSession && !force) return;
    lastSession = key;
    androidPost('session', { on, keepAlive });
  };
  const tick = () => {
    let voice = null;
    let ring = null;
    for (const c of connRegistry.values()) {
      const s = c.getState();
      if (s.voice?.channelId) voice = s.voice;
      if (s.incomingCall) ring = s.incomingCall;
    }
    const call = voice
      ? { active: true, camera: Boolean(voice.localCamera), text: voice.muted ? 'Microfone desligado' : '' }
      : { active: false };
    const callKey = JSON.stringify(call);
    if (callKey !== lastCall) {
      lastCall = callKey;
      androidPost('call', call);
    }
    const ringKey = ring ? `${ring.dmId}|${ring.from?.id || ''}` : '';
    if (ringKey !== lastRing) {
      lastRing = ringKey;
      androidPost(
        'ring',
        ring
          ? { dmId: ring.dmId, name: ring.from?.displayName || ring.from?.username || '', group: Boolean(ring.group) }
          : { dmId: null },
      );
    }
    syncSession();
  };
  // Cada conexão avisa quando muda (a chamada que chega pelo WebSocket dispara na hora).
  const watched = new Set();
  const watch = () => {
    for (const c of connRegistry.values()) {
      if (watched.has(c)) continue;
      watched.add(c);
      c.subscribe(tick);
    }
    tick();
  };
  useStore.subscribe((s, prev) => s.connKeys !== prev.connKeys && watch());
  watch();
  setInterval(tick, 5000);
  androidPost('ready');
}
