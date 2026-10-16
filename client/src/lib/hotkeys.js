// Atalhos de voz (silenciar / ensurdecer), configuráveis nas Configurações.
// - App do Windows: atalho global (funciona com o PadoSpeak minimizado, na bandeja ou atrás de um jogo).
// - Navegador e app instalado (PWA): só com a janela em foco — o navegador não deixa ir além disso.
// Cada atalho é `{ ctrl, alt, shift, meta, code }` (`code` do teclado, ex.: "KeyM", "F9"), ou null.
// Uma tecla modificadora sozinha ("ControlRight", "AltLeft"…) também vale: dispara no *toque* (apertar e
// soltar sem outra tecla no meio), para Ctrl+C e companhia não silenciarem ninguém. No app do Windows
// quem vê esses toques fora da janela é o próprio app (solo_keys.rs).
import { isTauri } from './env.js';

/** Ações com atalho, na ordem em que aparecem nas Configurações. */
export const HOTKEY_ACTIONS = [
  { id: 'mute', label: 'Silenciar / ativar o microfone' },
  { id: 'deafen', label: 'Ensurdecer / voltar a ouvir' },
];

/** Atalhos padrão (os mais comuns em apps de voz). */
export const DEFAULT_HOTKEYS = {
  mute: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyM' },
  deafen: { ctrl: true, shift: true, alt: false, meta: false, code: 'KeyD' },
};

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;
/** Teclas que podem ser atalho sozinhas (sem Ctrl/Alt/Shift): não atrapalham quem está digitando. */
const SOLO_OK = /^(F\d{1,2}|Pause|ScrollLock|Insert|Numpad.+|Media.+|AudioVolume.+)$/;

/** Atalho de cada ação (o padrão quando a pessoa nunca mexeu; null = desligado). */
export function hotkeysOf(prefs) {
  return { ...DEFAULT_HOTKEYS, ...(prefs?.hotkeys || {}) };
}

/** O atalho é uma tecla modificadora sozinha (Ctrl, Alt, Shift ou Win)? */
export const isSoloHotkey = (k) => Boolean(k && MODIFIER_CODES.test(k.code));

const SOLO_NAMES = {
  ControlLeft: 'Ctrl esquerdo',
  ControlRight: 'Ctrl direito',
  ShiftLeft: 'Shift esquerdo',
  ShiftRight: 'Shift direito',
  AltLeft: 'Alt',
  AltRight: 'Alt Gr',
  MetaLeft: 'Win',
  MetaRight: 'Win direito',
};

/** Nome da tecla para mostrar: KeyM → M, Digit1 → 1, Numpad1 → Num 1. */
function keyName(code) {
  if (SOLO_NAMES[code]) return SOLO_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return (
    { Space: 'Espaço', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: 'Ç', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[
      code
    ] || code
  );
}

/** "Ctrl + Shift + M". */
export function formatHotkey(k) {
  if (!k) return 'Nenhum';
  if (isSoloHotkey(k)) return keyName(k.code);
  return [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Win', keyName(k.code)].filter(Boolean).join(' + ');
}

/**
 * Atalho a partir de uma tecla apertada (ao gravar). Devolve `{ hotkey }`, `{ waiting: true }` (só
 * modificadores até agora) ou `{ error }`.
 */
export function hotkeyFromEvent(e) {
  if (MODIFIER_CODES.test(e.code) || !e.code) return { waiting: true };
  const hotkey = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code };
  const mods = hotkey.ctrl || hotkey.alt || hotkey.meta;
  if (!mods && !SOLO_OK.test(e.code) && !(hotkey.shift && /^F\d/.test(e.code)))
    return { error: 'Use Ctrl, Alt ou Win junto com a tecla (ou uma tecla F1–F24, Pause, Num…).' };
  return { hotkey };
}

/** Só esta modificadora está apertada (para gravar/disparar o toque de uma tecla sozinha)? */
function onlyModifier(e) {
  const held = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey].filter(Boolean).length;
  // AltGr no Windows chega como Ctrl + Alt.
  return held === 1 || (e.code === 'AltRight' && held <= 2);
}

/**
 * Gravando um atalho: acompanha os toques de modificadora sozinha. `keydown(e)` / `keyup(e)` devolvem o
 * atalho quando a pessoa aperta e solta Ctrl, Alt, Shift ou Win sem outra tecla.
 */
export function soloRecorder() {
  let pending = null;
  return {
    keydown(e) {
      pending = MODIFIER_CODES.test(e.code) && onlyModifier(e) && !pending ? e.code : null;
    },
    keyup(e) {
      const hit = pending && e.code === pending;
      pending = null;
      return hit ? { ctrl: false, alt: false, shift: false, meta: false, code: e.code } : null;
    },
  };
}

const same = (a, b) => a && b && a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta;
export const sameHotkey = same;

/** O atalho, no formato do Tauri ("Control+Shift+KeyM"). */
const accelerator = (k) => [k.ctrl && 'Control', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Super', k.code].filter(Boolean).join('+');

let registered = []; // aceleradores registrados no Windows
let current = {}; // ação → atalho
let handlers = {}; // ação → função
let windowFallback = new Set(); // ações que ficaram só na janela (o Windows recusou o global)
let gen = 0;
let soloListening = false;
/** Ações cujo atalho global o Windows recusou (outro programa já usa a combinação). */
export const hotkeyProblems = new Set();
const listeners = new Set();
export const onHotkeyProblems = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Dispara a ação de um atalho de tecla sozinha (`code`), se houver. */
function fireSolo(code) {
  if (document.querySelector('.hotkey-input.recording')) return;
  for (const [action, k] of Object.entries(current)) if (isSoloHotkey(k) && k.code === code) handlers[action]?.();
}

// Toque de modificadora sozinha na janela (no app do Windows quem cuida é o app, em qualquer lugar).
let tapping = null;
function onTapDown(e) {
  if (e.repeat) return;
  tapping = MODIFIER_CODES.test(e.code) && onlyModifier(e) && !tapping ? e.code : null;
}
function onTapUp(e) {
  const hit = tapping && e.code === tapping;
  tapping = null;
  if (hit && !isTauri) fireSolo(e.code);
}
const cancelTap = () => (tapping = null);

// Na janela (navegador, PWA; no app do Windows, só se o atalho global falhou).
function onKeyDown(e) {
  onTapDown(e);
  if (e.repeat) return;
  for (const [action, k] of Object.entries(current)) {
    if (!k || isSoloHotkey(k) || !same(k, { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code })) continue;
    if (isTauri && !windowFallback.has(action)) continue;
    // Gravando um atalho nas Configurações: não dispara.
    if (document.querySelector('.hotkey-input.recording')) return;
    e.preventDefault();
    e.stopPropagation();
    handlers[action]?.();
    return;
  }
}

/**
 * Liga (ou atualiza) os atalhos: `map` ação → atalho, `actions` ação → função. Chamado sempre que as
 * preferências mudam.
 */
export async function applyHotkeys(map, actions) {
  current = map;
  handlers = actions;
  window.removeEventListener('keydown', onKeyDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onTapUp, true);
  window.addEventListener('keyup', onTapUp, true);
  window.removeEventListener('mousedown', cancelTap, true);
  window.addEventListener('mousedown', cancelTap, true);
  window.removeEventListener('blur', cancelTap);
  window.addEventListener('blur', cancelTap);
  if (!isTauri) return;
  const my = ++gen;
  // Teclas sozinhas: o app do Windows avisa cada toque (fora da janela também).
  const solo = Object.values(map).filter(isSoloHotkey).map((k) => k.code);
  const { invoke } = await import('@tauri-apps/api/core');
  invoke('solo_keys_set', { codes: solo }).catch((e) => console.warn('[atalhos] teclas sozinhas', e));
  if (!soloListening) {
    soloListening = true;
    const { listen } = await import('@tauri-apps/api/event');
    await listen('solo-key', (e) => fireSolo(e.payload));
  }
  const gs = await import('@tauri-apps/plugin-global-shortcut');
  if (registered.length) await gs.unregister(registered).catch(() => {});
  registered = [];
  windowFallback = new Set();
  hotkeyProblems.clear();
  for (const [action, k] of Object.entries(map)) {
    if (!k || isSoloHotkey(k) || my !== gen) continue;
    const acc = accelerator(k);
    try {
      await gs.register(acc, (ev) => ev.state === 'Pressed' && handlers[action]?.());
      registered.push(acc);
    } catch (e) {
      console.warn('[atalhos] o Windows recusou', acc, e);
      windowFallback.add(action);
      hotkeyProblems.add(action);
    }
  }
  for (const fn of listeners) fn();
}

/** Desliga os atalhos globais por um instante (enquanto a pessoa grava um atalho novo). */
export async function pauseGlobalHotkeys() {
  if (!isTauri || !registered.length) return;
  const gs = await import('@tauri-apps/plugin-global-shortcut');
  await gs.unregister(registered).catch(() => {});
  registered = [];
}

/** Registra de novo os atalhos atuais (ex.: a pessoa desistiu de gravar um atalho novo). */
export const refreshHotkeys = () => applyHotkeys(current, handlers);
