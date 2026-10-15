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


/** As 6 cores principais do texto (Ctrl+1…6), personalizáveis nas configurações. */
export const DEFAULT_PALETTE = ['#e2331f', '#e8781a', '#c79100', '#2e9e1a', '#1a7fc4', '#7b44c8'];

/** Paleta pessoal (com as cores padrão no lugar das que faltarem). */
export function paletteOf(prefs) {
  const p = Array.isArray(prefs?.textPalette) ? prefs.textPalette : [];
  return DEFAULT_PALETTE.map((c, i) => (/^#[0-9a-f]{6}$/i.test(p[i] || '') ? p[i] : c));
}
