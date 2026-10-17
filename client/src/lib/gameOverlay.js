// App do Windows: sobreposição nos jogos. Enquanto o jogo detectado para a atividade está em foco e
// você está numa chamada, uma janela transparente por cima dele mostra as fotos de quem está na
// chamada (quem fala acende) e a música tocando. O app decide quando mostrar (desktop/src-tauri/src/overlay.rs);
// daqui vai só o que aparecer nela (overlay.html).
import { isTauri } from './env.js';

let enabled = false;
let state = null;
let on = null;
let sent = '';
let listening = false;

async function push() {
  if (!isTauri) return;
  const [{ invoke }, { emitTo, listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  if (!listening) {
    listening = true;
    // A janela acabou de abrir: manda o estado atual.
    await listen('overlay-ready', () => {
      sent = '';
      push();
    });
  }
  const want = enabled && Boolean(state);
  if (want !== on) {
    on = want;
    invoke('overlay_set', { on: want }).catch((e) => console.warn('[sobreposição]', e));
  }
  const json = JSON.stringify(state);
  if (want && json !== sent) {
    sent = json;
    emitTo('game-overlay', 'overlay-state', state).catch(() => {});
  }
}

/** A opção de Configurações → Funcionalidade. */
export function setGameOverlay(pref) {
  enabled = Boolean(pref);
  push();
}

/**
 * O que aparece na sobreposição, ou null fora da chamada:
 * { music: { title, artist, paused } | null, people: [{ id, name, src, color, speaking, muted, deafened }] }.
 */
export function syncGameOverlay(next) {
  state = next;
  globalThis.__padospeakOverlay = next; // diagnóstico pelo DevTools
  push();
}
