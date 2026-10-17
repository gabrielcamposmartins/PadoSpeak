// Barra de formatação (negrito, itálico, sublinhado, riscado, cor e emoticons) que grava as tags no
// próprio texto. A mesma barra serve a caixa de mensagem, o nome e a mensagem pessoal.
//
// Atalhos (em qualquer caixa com formatação): Ctrl+B negrito, Ctrl+I itálico, Ctrl+U sublinhado,
// Ctrl+Shift+X riscado e Ctrl+1…8 as cores da paleta pessoal (Configurações → Formatação de texto).
// Sem nada selecionado, a cor pinta a mensagem toda; repetir a mesma cor tira a cor.
import { useRef, useState } from 'react';
import { Bold, Italic, Underline, Strikethrough, Smile, Baseline } from 'lucide-react';
import { useStore } from '../store.js';
import { EmojiPicker, ColorPicker, editField, insertText } from './Emotes.jsx';
import { DEFAULT_PALETTE, paletteOf, colorSpans } from '../lib/text.js';

export { DEFAULT_PALETTE, paletteOf };
export const usePalette = () => paletteOf(useStore((s) => s.prefs));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Atalhos mostrados nas configurações e nas dicas dos botões. */
export const SHORTCUTS = [
  [`${MOD}+B`, 'Negrito'],
  [`${MOD}+I`, 'Itálico'],
  [`${MOD}+U`, 'Sublinhado'],
  [`${MOD}+Shift+X`, 'Riscado'],
  [`${MOD}+1 … ${MOD}+8`, 'Cores da sua paleta'],
];

const WRAPS = { b: ['**', '**', 'negrito'], i: ['*', '*', 'itálico'], u: ['__', '__', 'sublinhado'], x: ['~~', '~~', 'riscado'] };

/** Embrulha a seleção com `before`/`after`; se ela já estiver embrulhada, tira. */
function toggleWrap(el, text, setText, before, after, placeholder) {
  const start = el?.selectionStart ?? text.length;
  const end = el?.selectionEnd ?? text.length;
  if (start !== end && text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    setText(text.slice(0, start - before.length) + text.slice(start, end) + text.slice(end + after.length));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start - before.length, end - before.length);
    });
    return;
  }
  editField(el, text, setText, before, after, start === end ? '' : placeholder);
}

/**
 * Pinta a seleção (ou a mensagem toda, sem seleção) com uma cor. A tag nova nunca corta outra no meio:
 * se o trecho já é um colorido inteiro, troca a cor dele (a mesma cor tira); se pega só parte de um
 * colorido, a seleção cresce até englobá-lo, e a cor nova fica por fora (as de dentro continuam).
 * `placeholder`: sem seleção, insere um texto de exemplo em vez de pintar a mensagem toda.
 */
export function applyColor(el, text, setText, hex, placeholder = '') {
  let start = el?.selectionStart ?? text.length;
  let end = el?.selectionEnd ?? text.length;
  // Mensagem toda: o cursor vai para o fim (para continuar escrevendo); seleção: o trecho pintado.
  const select = (next, a, b) =>
    requestAnimationFrame(() => {
      el?.focus();
      if (whole) el?.setSelectionRange(next.length, next.length);
      else el?.setSelectionRange(a, b);
    });
  const whole = start === end;
  if (whole) {
    if (placeholder || !text.trim()) return editField(el, text, setText, `[cor=${hex}]`, '[/cor]', placeholder);
    start = 0;
    end = text.length;
  }
  const spans = colorSpans(text);
  // Não cortar um colorido: se a seleção pega parte dele (ou das tags), passa a pegá-lo inteiro.
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of spans) {
      const overlaps = start < s.end && end > s.open;
      const inside = start >= s.innerStart && end <= s.innerEnd;
      const covers = start <= s.open && end >= s.end;
      if (overlaps && !inside && !covers) {
        start = Math.min(start, s.open);
        end = Math.max(end, s.end);
        grew = true;
      }
    }
  }
  // Espaços nas pontas ficam de fora.
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (start === end) return;
  // O trecho já é um colorido inteiro (com ou sem as tags na seleção): troca a cor, ou tira se for a mesma.
  const same = spans.find((s) => (s.open === start && s.end === end) || (s.innerStart === start && s.innerEnd === end));
  if (same) {
    const inner = text.slice(same.innerStart, same.innerEnd);
    const tag = same.hex.toLowerCase() === hex.toLowerCase() ? ['', ''] : [`[cor=${hex}]`, '[/cor]'];
    const next = text.slice(0, same.open) + tag[0] + inner + tag[1] + text.slice(same.end);
    setText(next);
    const a = same.open + tag[0].length;
    return select(next, a, a + inner.length);
  }
  const next = `${text.slice(0, start)}[cor=${hex}]${text.slice(start, end)}[/cor]${text.slice(end)}`;
  setText(next);
  const a = start + `[cor=${hex}]`.length;
  select(next, a, a + (end - start));
}

/**
 * Trata um atalho de formatação no `keydown` de uma caixa de texto. Devolve `true` se tratou.
 * `maxRaw`: limite do texto com as tags.
 */
export function formatKey(e, el, text, setText, maxRaw) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.nativeEvent?.isComposing) return false;
  const guarded = (next) => {
    if (maxRaw && next.length > maxRaw) return useStore.getState().notify('Não cabe mais formatação neste texto', 'info');
    setText(next);
  };
  const digit = /^Digit([1-8])$/.exec(e.code) || /^Numpad([1-8])$/.exec(e.code);
  if (digit && !e.shiftKey) {
    e.preventDefault();
    applyColor(el, text, guarded, paletteOf(useStore.getState().prefs)[Number(digit[1]) - 1]);
    return true;
  }
  const key = e.key.toLowerCase();
  const which = e.shiftKey ? (key === 'x' ? 'x' : null) : ['b', 'i', 'u'].includes(key) ? key : null;
  if (!which) return false;
  e.preventDefault();
  const [before, after, placeholder] = WRAPS[which];
  toggleWrap(el, text, guarded, before, after, placeholder);
  return true;
}

/**
 * `maxRaw`: tamanho máximo do texto com as tags (o servidor recusa acima disso).
 * `children`: botões extras no fim da barra (stickers, chamar atenção).
 */
export default function FormatTools({ inputRef, text, setText, maxRaw, children, label = 'Opções de texto' }) {
  const [open, setOpen] = useState(null); // 'emoji' | 'color'
  const colorBtn = useRef(null);
  const palette = usePalette();
  const emojiBtn = useRef(null);
  // Não deixa a formatação passar do limite do campo.
  const guarded = (next) => {
    if (maxRaw && next.length > maxRaw) return useStore.getState().notify('Não cabe mais formatação neste texto', 'info');
    setText(next);
  };
  const wrap = (before, after, placeholder) => editField(inputRef.current, text, guarded, before, after, placeholder);
  const tools = [
    [Bold, 'Negrito', `${MOD}+B`, () => wrap('**', '**', 'negrito')],
    [Italic, 'Itálico', `${MOD}+I`, () => wrap('*', '*', 'itálico')],
    [Underline, 'Sublinhado', `${MOD}+U`, () => wrap('__', '__', 'sublinhado')],
    [Strikethrough, 'Riscado', `${MOD}+Shift+X`, () => wrap('~~', '~~', 'riscado')],
  ];
  return (
    <div className="composer-tools" role="toolbar" aria-label={label}>
      {tools.map(([Icon, name, keys, fn]) => (
        <button key={name} type="button" className="gloss tool-sq" title={`${name} (${keys})`} aria-label={name} onClick={fn}>
          <Icon size={15} />
        </button>
      ))}
      <span className="tool-wrap">
        <button
          ref={colorBtn}
          type="button"
          className={`gloss tool-sq${open === 'color' ? ' pressed' : ''}`}
          title={`Cor do texto (${MOD}+1 … ${MOD}+8)`}
          aria-label="Cor do texto"
          aria-expanded={open === 'color'}
          onClick={() => setOpen(open === 'color' ? null : 'color')}
        >
          <Baseline size={15} className="ico-color" />
        </button>
        {open === 'color' && (
          <ColorPicker
            anchorRef={colorBtn}
            palette={palette}
            onClose={() => setOpen(null)}
            onPick={(hex) => {
              setOpen(null);
              applyColor(inputRef.current, text, guarded, hex, 'texto colorido');
            }}
          />
        )}
      </span>
      <span className="tool-sep" />
      <span className="tool-wrap">
        <button
          ref={emojiBtn}
          type="button"
          className={`gloss tool-sq${open === 'emoji' ? ' pressed' : ''}`}
          title="Emoticons"
          aria-label="Emoticons"
          aria-expanded={open === 'emoji'}
          onClick={() => setOpen(open === 'emoji' ? null : 'emoji')}
        >
          <Smile size={15} className="ico-gold" />
        </button>
        {open === 'emoji' && (
          <EmojiPicker
            anchorRef={emojiBtn}
            onClose={() => setOpen(null)}
            onPick={(code) => {
              setOpen(null);
              insertText(inputRef.current, text, guarded, code);
            }}
          />
        )}
      </span>
      {children}
    </div>
  );
}
