// Texto com formatação (nome, mensagem pessoal, mensagens): versão sem as tags.

/** O texto sem as tags de formatação (para títulos, avisos, ordenação e a inicial da foto). */
export function plain(text) {
  return String(text ?? '')
    .replace(/\[cor=#[0-9a-fA-F]{6}\]/g, '')
    .replace(/\[\/cor\]/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1');
}

/** Tamanho que aparece na tela (as tags não contam). */
export const visibleLength = (text) => [...plain(text)].length;

/** `@usuario` (letras, números, _ e .) ou `@everyone`, sem colar em outra palavra ou e-mail. */
export const MENTION_RE = /(?<![\w.@])@(everyone|[A-Za-z0-9_.]*[A-Za-z0-9_])/;

/** O texto menciona `username` (ou todos, com @everyone)? */
export function mentionsUser(text, username) {
  if (!text || !username) return false;
  const me = username.toLowerCase();
  const re = new RegExp(MENTION_RE.source, 'g');
  for (const m of String(text).matchAll(re)) {
    const who = m[1].toLowerCase();
    if (who === 'everyone' || who === me) return true;
  }
  return false;
}


/** As 8 cores principais do texto (Ctrl+1…8), personalizáveis nas configurações. */
export const DEFAULT_PALETTE = ['#e2331f', '#e8781a', '#c79100', '#2e9e1a', '#0f9f9a', '#1a7fc4', '#7b44c8', '#d6418f'];

/** Paleta pessoal (com as cores padrão no lugar das que faltarem). */
export function paletteOf(prefs) {
  const p = Array.isArray(prefs?.textPalette) ? prefs.textPalette : [];
  return DEFAULT_PALETTE.map((c, i) => (/^#[0-9a-f]{6}$/i.test(p[i] || '') ? p[i] : c));
}

const COLOR_TAG = /\[cor=(#[0-9a-fA-F]{6})\]|\[\/cor\]/g;

/**
 * Trechos coloridos do texto, casando cada `[cor=#hex]` com o seu `[/cor]` (uma cor pode ficar dentro
 * de outra). Cada um: `{ hex, open, innerStart, innerEnd, end }` (posições no texto com as tags).
 */
export function colorSpans(text) {
  const spans = [];
  const stack = [];
  COLOR_TAG.lastIndex = 0;
  for (let m; (m = COLOR_TAG.exec(text)); ) {
    if (m[1]) stack.push({ hex: m[1], open: m.index, innerStart: m.index + m[0].length });
    else if (stack.length) {
      const s = stack.pop();
      spans.push({ ...s, innerEnd: m.index, end: m.index + m[0].length });
    }
  }
  return spans.sort((a, b) => a.open - b.open);
}
