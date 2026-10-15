// Atalhos de voz (silenciar / ensurdecer), configuráveis nas Configurações.
// - App do Windows: atalho global (funciona com o PadoSpeak minimizado, na bandeja ou atrás de um jogo).
// - Navegador e app instalado (PWA): só com a janela em foco — o navegador não deixa ir além disso.
// Cada atalho é `{ ctrl, alt, shift, meta, code }` (`code` do teclado, ex.: "KeyM", "F9"), ou null.
import { isTauri } from './env.js';

/** Ações com atalho, na ordem em que aparecem nas Configurações. */
export const HOTKEY_ACTIONS = [
  { id: 'mute', label: 'Silenciar / ativar o microfone' },
  { id: 'deafen', label: 'Ensurdecer / voltar a ouvir' },
];

/** Iguais aos do Discord. */
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

/** Nome da tecla para mostrar: KeyM → M, Digit1 → 1, Numpad1 → Num 1. */
function keyName(code) {
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

const same = (a, b) => a && b && a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift && !!a.meta === !!b.meta;
export const sameHotkey = same;

/** O atalho, no formato do Tauri ("Control+Shift+KeyM"). */
const accelerator = (k) => [k.ctrl && 'Control', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Super', k.code].filter(Boolean).join('+');

let registered = []; // aceleradores registrados no Windows
let current = {}; // ação → atalho
let handlers = {}; // ação → função
let windowFallback = new Set(); // ações que ficaram só na janela (o Windows recusou o global)
let gen = 0;
/** Ações cujo atalho global o Windows recusou (outro programa já usa a combinação). */
export const hotkeyProblems = new Set();
const listeners = new Set();
export const onHotkeyProblems = (fn) => (listeners.add(fn), () => listeners.delete(fn));

// Na janela (navegador, PWA; no app do Windows, só se o atalho global falhou).
function onKeyDown(e) {
  if (e.repeat) return;
  for (const [action, k] of Object.entries(current)) {
    if (!k || !same(k, { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code })) continue;
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
  if (!isTauri) return;
  const my = ++gen;
  const gs = await import('@tauri-apps/plugin-global-shortcut');
  if (registered.length) await gs.unregister(registered).catch(() => {});
  registered = [];
  windowFallback = new Set();
  hotkeyProblems.clear();
  for (const [action, k] of Object.entries(map)) {
    if (!k || my !== gen) continue;
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
