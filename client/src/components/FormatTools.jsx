// Barra de formatação (negrito, itálico, sublinhado, riscado, cor e emoticons) dos campos de formatação
// (RichInput.jsx): aplica na hora, no próprio campo. A mesma barra serve a caixa de mensagem, o nome, a
// mensagem pessoal e as anotações da agenda.
//
// Atalhos (em qualquer campo com formatação): Ctrl+B negrito, Ctrl+I itálico, Ctrl+U sublinhado,
// Ctrl+Shift+X riscado e Ctrl+1…8 as cores da paleta pessoal (Configurações → Formatação de texto).
// Sem nada selecionado, a cor pinta o texto todo (com o campo vazio, o que vier a seguir); repetir a mesma
// cor tira a cor.
import { useRef, useState } from 'react';
import { Bold, Italic, Underline, Strikethrough, Smile, Baseline, ChevronRight } from 'lucide-react';
import { useStore } from '../store.js';
import { EmojiPicker, ColorPicker } from './Emotes.jsx';
import { DEFAULT_PALETTE, paletteOf } from '../lib/text.js';

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

/**
 * `inputRef`: o campo (RichInput), que recebe os comandos.
 * `children`: botões extras no fim da barra (stickers, chamar atenção).
 * `phone`: a barra da caixa de mensagem no celular, sempre numa linha só, com botões maiores: a cor fica
 * à mão e negrito, itálico, sublinhado e riscado ficam atrás de uma setinha. Aberta, a setinha ocupa o
 * lugar dos outros botões (que voltam ao fechar).
 */
export default function FormatTools({ inputRef, children, label = 'Opções de texto', phone = false }) {
  const [open, setOpen] = useState(null); // 'emoji' | 'color'
  const [effects, setEffects] = useState(false); // celular: itálico, sublinhado e riscado à mostra
  const colorBtn = useRef(null);
  const palette = usePalette();
  const emojiBtn = useRef(null);
  const tools = [
    [Bold, 'Negrito', `${MOD}+B`, () => inputRef.current?.format('b')],
    [Italic, 'Itálico', `${MOD}+I`, () => inputRef.current?.format('i')],
    [Underline, 'Sublinhado', `${MOD}+U`, () => inputRef.current?.format('u')],
    [Strikethrough, 'Riscado', `${MOD}+Shift+X`, () => inputRef.current?.format('s')],
  ];
  // os botões não tiram o foco (nem a seleção) do campo
  const keepFocus = (e) => e.preventDefault();
  const button = ([Icon, name, keys, fn]) => (
    <button key={name} type="button" className="gloss tool-sq" title={`${name} (${keys})`} aria-label={name} onMouseDown={keepFocus} onClick={fn}>
      <Icon size={15} />
    </button>
  );
  return (
    <div className={`composer-tools${phone ? ' phone-tools' : ''}`} role="toolbar" aria-label={label}>
      {!phone && tools.map(button)}
      <span className="tool-wrap">
        <button
          ref={colorBtn}
          type="button"
          className={`gloss tool-sq${open === 'color' ? ' pressed' : ''}`}
          title={`Cor do texto (${MOD}+1 … ${MOD}+8)`}
          aria-label="Cor do texto"
          aria-expanded={open === 'color'}
          onMouseDown={keepFocus}
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
              inputRef.current?.color(hex);
            }}
          />
        )}
      </span>
      {phone && (
        <span className={`tool-effects${effects ? ' open' : ''}`}>
          <button
            type="button"
            className={`gloss tool-sq tool-more${effects ? ' pressed' : ''}`}
            title={effects ? 'Esconder negrito, itálico, sublinhado e riscado' : 'Negrito, itálico, sublinhado e riscado'}
            aria-label="Mais efeitos de texto"
            aria-expanded={effects}
            onMouseDown={keepFocus}
            onClick={() => setEffects((v) => !v)}
          >
            <ChevronRight size={15} />
          </button>
          {effects && tools.map(button)}
        </span>
      )}
      {/* Celular: com a setinha aberta, os efeitos ocupam a linha toda. */}
      {!(phone && effects) && (
        <>
          <span className="tool-sep" />
          <span className="tool-wrap">
            <button
              ref={emojiBtn}
              type="button"
              className={`gloss tool-sq${open === 'emoji' ? ' pressed' : ''}`}
              title="Emoticons"
              aria-label="Emoticons"
              aria-expanded={open === 'emoji'}
              onMouseDown={keepFocus}
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
                  inputRef.current?.insertEmote(code);
                }}
              />
            )}
          </span>
          {children}
        </>
      )}
    </div>
  );
}
