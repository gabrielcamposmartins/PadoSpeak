// App do Windows: sobreposição nos jogos. Enquanto o jogo detectado para a atividade está em foco e
// você está numa chamada, uma janela transparente por cima dele mostra as fotos de quem está na
// chamada (quem fala acende) e a música tocando. O app decide quando mostrar (desktop/src-tauri/src/overlay.rs);
// daqui vai só o que aparecer nela (overlay.html).
import { isTauri } from './env.js';

let enabled = false;
let corner = 'tl';
let state = null;
let on = null;
let side = null;
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
  const right = corner.endsWith('r');
  if (want !== on || right !== side) {
    on = want;
    side = right;
    invoke('overlay_set', { on: want, right }).catch((e) => console.warn('[sobreposição]', e));
  }
  const view = state && { ...state, corner };
  const json = JSON.stringify(view);
  if (want && json !== sent) {
    sent = json;
    emitTo('game-overlay', 'overlay-state', view).catch(() => {});
  }
}

/** Jogos (pelo nome que aparece no status) em que a sobreposição não aparece. */
export async function setOverlayBlocked(names) {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  invoke('overlay_block_set', { names: (names || []).filter(Boolean) }).catch((e) => console.warn('[sobreposição]', e));
}

/** A opção de Configurações → Funcionalidade, e o canto da tela (tl, tr, bl, br). */
export function setGameOverlay(pref, where) {
  enabled = Boolean(pref);
  if (['tl', 'tr', 'bl', 'br'].includes(where)) corner = where;
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
