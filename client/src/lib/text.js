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

