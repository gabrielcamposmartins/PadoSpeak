// App do Windows: enquanto você transmite, um dock flutuante (sempre por cima, fora da própria
// transmissão) com Trocar, Som, Parar e Ocultar. A barra "Parar compartilhamento / Ocultar" que o
// WebView2 mostra é dele e não aceita botões novos; este dock é do PadoSpeak (dock.html).
import { isTauri } from './env.js';

let open = false;
let hidden = false; // "Ocultar": some até a próxima transmissão
let listening = false;
let actions = {};
let state = null;
let barHidden = false; // a barra de compartilhamento do WebView2 está sendo escondida

/** Enquanto transmite, a barra "Parar compartilhamento / Ocultar" do WebView2 fica escondida: o dock é o
 * aviso de que a transmissão está no ar (mesmo depois de "Ocultar" o dock, ela não volta). */
function hideWebviewBar(on) {
  if (barHidden === on) return;
  barHidden = on;
  tauri().then(({ invoke }) => invoke('share_bar_hide', { on }).catch(() => {}));
}

async function tauri() {
  const [{ invoke }, { emitTo, listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  return { invoke, emitTo, listen };
}

async function listenOnce() {
  if (listening) return;
  listening = true;
  const { listen, emitTo } = await tauri();
  await listen('share-dock-action', async (e) => {
    if (e.payload === 'hide') {
      hidden = true;
      close();
      return;
    }
    await actions[e.payload]?.();
  });
  // O dock acabou de abrir: manda o estado atual.
  await listen('share-dock-ready', () => state && emitTo('share-dock', 'share-state', state).catch(() => {}));
}

function close() {
  if (!open) return;
  open = false;
  tauri().then(({ invoke }) => invoke('share_dock_close').catch(() => {}));
}

/**
 * Acompanha a chamada (`snap` do VoiceClient, ou null fora dela). `acts`: { switch, audio, stop }.
 */
export async function syncShareDock(snap, acts) {
  if (!isTauri) return;
  if (acts) actions = acts;
  if (!snap?.screen) {
    hidden = false;
    state = null;
    close();
    hideWebviewBar(false);
    return;
  }
  hideWebviewBar(true);
  state = { label: snap.screenLabel || 'Tela', hasAudio: Boolean(snap.screenHasAudio), audioMuted: Boolean(snap.screenAudioMuted) };
  await listenOnce();
  const { invoke, emitTo } = await tauri();
  if (!open && !hidden) {
    open = true;
    await invoke('share_dock_open').catch((e) => {
      open = false;
      console.warn('[dock] não abriu', e);
    });
  }
  if (open) emitTo('share-dock', 'share-state', state).catch(() => {});
}
