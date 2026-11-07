// Campo com a formatação aplicada na hora: negrito, itálico, sublinhado, riscado, cor e emoticons aparecem
// no próprio campo, sem tags. Por baixo, o texto continua no formato que o resto do app desenha (veja
// formatTree em Emotes.jsx): [b]…[/b], [i]…[/i], [u]…[/u], [s]…[/s], [cor=#hex]…[/cor] e os códigos dos
// emoticons. O formato antigo (**negrito**, *itálico*, __sublinhado__, ~~riscado~~) também é lido.
//
// A barra de formatação (FormatTools.jsx) e os atalhos usam os comandos do navegador (execCommand) sobre a
// seleção; o campo transforma o que está nele de volta em texto a cada mudança. Atalhos: Ctrl+B, Ctrl+I,
// Ctrl+U, Ctrl+Shift+X (riscado) e Ctrl+1…8 (as cores da paleta pessoal); digitar o código de um emoticon
// já mostra o desenho.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { useStore } from '../store.js';
import { EMOTES, formatTree, emoteUrl } from './Emotes.jsx';
import { paletteOf } from '../lib/text.js';

/** Códigos dos emoticons, do mais comprido para o mais curto (":-)" antes de ":)"). */
const CODES = EMOTES.map((e) => e.code).sort((a, b) => b.length - a.length);
/** Ordem das tags, de fora para dentro (cada uma abre no máximo uma vez: nunca se cruzam). */
const ORDER = ['color', 'b', 'u', 's', 'i'];
const OPEN = { b: '[b]', i: '[i]', u: '[u]', s: '[s]' };
const CLOSE = { color: '[/cor]', b: '[/b]', i: '[/i]', u: '[/u]', s: '[/s]' };
const COMMANDS = { b: 'bold', i: 'italic', u: 'underline', s: 'strikeThrough' };
/** Cor provisória para tirar a cor de um trecho (o navegador não tem "sem cor"): some logo depois. */
const NO_COLOR = '#010203';

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const emoteHtml = (code) => `<img class="re-emote" data-code="${escapeAttr(code)}" alt="${escapeAttr(code)}" src="${emoteUrl(code)}" draggable="false">`;
function emoteNode(code) {
  const img = document.createElement('img');
  img.className = 're-emote';
  img.dataset.code = code;
  img.alt = code;
  img.src = emoteUrl(code);
  img.draggable = false;
  return img;
}

/** `rgb(r, g, b)` ou `#rgb` → `#rrggbb`. */
function toHex(c) {
  if (!c) return null;
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (rgb) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
}

/** O texto (com as tags) → o que vai dentro do campo. */
function fill(el, text) {
  el.replaceChildren();
  const build = (nodes, parent) => {
    for (const n of nodes) {
      if (typeof n === 'string') {
        n.split('\n').forEach((part, i) => {
          if (i) parent.appendChild(document.createElement('br'));
          if (part) parent.appendChild(document.createTextNode(part));
        });
      } else if (n.emote) parent.appendChild(emoteNode(n.emote));
      else {
        const box = document.createElement(n.color ? 'font' : n.tag);
        if (n.color) box.setAttribute('color', n.color);
        build(n.children, box);
        parent.appendChild(box);
      }
    }
  };
  build(formatTree(text), el);
  // o navegador só mostra a última linha vazia com um <br> a mais
  if (text.endsWith('\n')) el.appendChild(document.createElement('br'));
}

/** O que está no campo → o texto com as tags. */
function read(el) {
  const runs = []; // { t, st } | { emote, st } | { br: true }
  const lastBr = () => runs.length > 0 && runs[runs.length - 1].br;
  const walk = (node, st) => {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.data.replace(/​/g, '');
        if (t) runs.push({ t, st });
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = n.tagName;
      if (tag === 'BR') {
        // o <br> que só segura uma linha vazia dentro de um bloco não conta
        const block = n.parentNode !== el && /^(DIV|P)$/.test(n.parentNode.tagName);
        if (!(block && n === n.parentNode.lastChild)) runs.push({ br: true });
        continue;
      }
      if (tag === 'IMG') {
        if (n.dataset.code) runs.push({ emote: n.dataset.code, st });
        continue;
      }
      const next = { ...st };
      if (tag === 'B' || tag === 'STRONG') next.b = true;
      if (tag === 'I' || tag === 'EM') next.i = true;
      if (tag === 'U') next.u = true;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.s = true;
      if (tag === 'FONT' && n.getAttribute('color')) next.color = toHex(n.getAttribute('color'));
      const s = n.style;
      if (s) {
        if (s.fontWeight === 'bold' || Number(s.fontWeight) >= 600) next.b = true;
        if (s.fontStyle === 'italic') next.i = true;
        const deco = `${s.textDecoration} ${s.textDecorationLine}`;
        if (deco.includes('underline')) next.u = true;
        if (deco.includes('line-through')) next.s = true;
        if (s.color) next.color = toHex(s.color) || next.color;
      }
      if (next.color === NO_COLOR) delete next.color;
      // um bloco (o navegador às vezes cria) começa numa linha nova
      if (/^(DIV|P)$/.test(tag) && runs.length && !lastBr()) runs.push({ br: true });
      walk(n, next);
    }
  };
  walk(el, {});
  if (el.lastChild?.nodeName === 'BR' && lastBr()) runs.pop();
  let out = '';
  let stack = [];
  const want = (st) => ORDER.filter((k) => st[k]).map((k) => ({ k, v: st[k] }));
  const sync = (st) => {
    const w = want(st);
    let keep = 0;
    while (keep < stack.length && keep < w.length && stack[keep].k === w[keep].k && stack[keep].v === w[keep].v) keep++;
    while (stack.length > keep) out += CLOSE[stack.pop().k];
    for (const x of w.slice(keep)) {
      out += x.k === 'color' ? `[cor=${x.v}]` : OPEN[x.k];
      stack.push(x);
    }
  };
  for (const r of runs) {
    if (r.br) {
      sync({});
      out += '\n';
    } else {
      sync(r.st);
      out += r.emote || r.t;
    }
  }
  sync({});
  return out;
}

/**
 * O campo. `value`/`onChange(texto)` como um <textarea> controlado (o texto com as tags). `multiline`:
 * Enter (ou Shift+Enter) quebra a linha; sem ele, o campo é de uma linha só. `maxLength`: tamanho do
 * texto com as tags. O `ref` dá os comandos da barra de formatação e o que as menções precisam.
 */
const RichInput = forwardRef(function RichInput(
  { value, onChange, onKeyDown, onPaste, onClick, onBlur, placeholder, multiline = false, maxLength, rows, autoFocus, className = '', ...rest },
  ref,
) {
  const el = useRef(null);
  /** O texto que está no campo agora (para não redesenhar o que a própria pessoa digitou). */
  const shown = useRef(null);
  const latest = useRef(value);
  latest.current = value;
  /** A última seleção dentro do campo (a barra de formatação e as janelinhas tiram o foco dele). */
  const saved = useRef(null);
  const composing = useRef(false);

  const caretToEnd = () => {
    const box = el.current;
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    saved.current = r.cloneRange();
  };
  const show = (text) => {
    fill(el.current, text);
    shown.current = text;
    el.current.toggleAttribute('data-empty', !text);
    if (document.activeElement === el.current) caretToEnd();
  };
  useLayoutEffect(() => {
    if (value !== shown.current) show(value || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (autoFocus) {
      el.current.focus();
      caretToEnd();
    }
    // guarda a seleção enquanto ela está no campo
    const keep = () => {
      const sel = window.getSelection();
      if (sel.rangeCount && el.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', keep);
    return () => document.removeEventListener('selectionchange', keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Volta o foco e a seleção para o campo (antes de um comando da barra). */
  const restore = () => {
    const box = el.current;
    const sel = window.getSelection();
    // o cursor já está no campo (atalho de teclado): vale ele. A seleção guardada pode estar atrás, porque o
    // `selectionchange` chega depois da tecla, e digitando rápido o Ctrl+B voltaria o cursor uma letra.
    if (document.activeElement === box && sel.rangeCount && box.contains(sel.anchorNode)) return;
    if (document.activeElement !== box) box.focus({ preventScroll: true });
    if (saved.current && box.contains(saved.current.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    } else if (!sel.rangeCount || !box.contains(sel.anchorNode)) caretToEnd();
  };
  /** Leu o campo: avisa quem usa (e volta atrás se passou do tamanho, ou se quem usa não aceitou). */
  const emit = () => {
    const next = read(el.current);
    if (next === shown.current) return;
    if (maxLength && next.length > maxLength) {
      document.execCommand('undo');
      useStore.getState().notify('Não cabe mais neste campo', 'info');
      return;
    }
    shown.current = next;
    el.current.toggleAttribute('data-empty', !next);
    onChange?.(next);
    // quem usa recusou (ex.: passou do limite visível): o campo volta ao que vale
    requestAnimationFrame(() => {
      if (el.current && latest.current !== shown.current) show(latest.current || '');
    });
  };
  const exec = (name, arg) => {
    restore();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(name, false, arg);
    emit();
  };
  /** Pinta a seleção (sem seleção: o texto todo, ou o que vier a seguir se o campo está vazio); a mesma cor tira. */
  const color = (hex) => {
    restore();
    const sel = window.getSelection();
    const whole = sel.isCollapsed && el.current.textContent.trim() !== '';
    if (whole) {
      const r = document.createRange();
      r.selectNodeContents(el.current);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const same = toHex(document.queryCommandValue('foreColor')) === hex.toLowerCase();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('foreColor', false, same ? NO_COLOR : hex);
    if (same) {
      // tira a cor provisória: o trecho fica sem cor nenhuma
      for (const f of el.current.querySelectorAll('font[color]')) if (toHex(f.getAttribute('color')) === NO_COLOR) f.replaceWith(...f.childNodes);
    }
    if (whole) caretToEnd();
    emit();
  };
  /** Digitou o código de um emoticon: ele vira o desenho. */
  const emoteAtCaret = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    if (node?.nodeType !== Node.TEXT_NODE) return;
    const before = node.data.slice(0, sel.anchorOffset);
    const code = CODES.find((c) => before.endsWith(c));
    if (!code) return;
    const r = document.createRange();
    r.setStart(node, sel.anchorOffset - code.length);
    r.setEnd(node, sel.anchorOffset);
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('insertHTML', false, emoteHtml(code));
  };

  useImperativeHandle(ref, () => ({
    rich: true,
    focus: () => restore(),
    blur: () => el.current?.blur(),
    format: (k) => exec(COMMANDS[k]),
    color,
    insertEmote: (code) => exec('insertHTML', emoteHtml(code)),
    insertText: (text) => exec('insertText', text),
    /** O texto (sem formatação) do começo do campo até o cursor, para as menções. */
    textBeforeCaret() {
      const sel = window.getSelection();
      if (!sel.rangeCount || !el.current.contains(sel.anchorNode)) return '';
      const r = document.createRange();
      r.selectNodeContents(el.current);
      r.setEnd(sel.anchorNode, sel.anchorOffset);
      return r.toString();
    },
    /** Troca os `n` caracteres antes do cursor por `text` (completar uma menção). */
    replaceBeforeCaret(n, text) {
      restore();
      const sel = window.getSelection();
      for (let i = 0; i < n; i++) sel.modify('extend', 'backward', 'character');
      document.execCommand('insertText', false, text);
      emit();
    },
  }));

  const keyDown = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (mod) {
      const key = e.key.toLowerCase();
      const digit = /^(?:Digit|Numpad)([1-8])$/.exec(e.code);
      if (digit && !e.shiftKey) {
        e.preventDefault();
        return color(paletteOf(useStore.getState().prefs)[Number(digit[1]) - 1]);
      }
      const which = e.shiftKey ? (key === 'x' ? 's' : null) : ['b', 'i', 'u'].includes(key) ? key : null;
      if (which) {
        e.preventDefault();
        return exec(COMMANDS[which]);
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (multiline) exec('insertLineBreak');
    }
  };

  return (
    <div
      {...rest}
      ref={el}
      className={`rich-input${multiline ? ' multi' : ' single'}${className ? ` ${className}` : ''}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={multiline}
      data-placeholder={placeholder}
      spellCheck
      style={rows ? { minHeight: `calc(${rows} * 1.45em + 14px)` } : undefined}
      onKeyDown={keyDown}
      onInput={(e) => {
        if (composing.current) return;
        if (e.nativeEvent.inputType === 'insertText') emoteAtCaret();
        emit();
      }}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => {
        composing.current = false;
        emit();
      }}
      onPaste={(e) => {
        onPaste?.(e);
        if (e.defaultPrevented) return;
        // colar entra como texto simples (a formatação de outros lugares não vem junto)
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        if (text) exec('insertText', multiline ? text : text.replace(/\s*\n\s*/g, ' '));
      }}
      onDrop={(e) => {
        // arquivos: quem usa o campo trata (ex.: a conversa); texto arrastado entra como texto simples
        if (e.dataTransfer.files?.length) return;
        e.preventDefault();
        const text = e.dataTransfer.getData('text/plain');
        if (text) exec('insertText', text);
      }}
      onClick={onClick}
      onBlur={onBlur}
    />
  );
});

export default RichInput;
