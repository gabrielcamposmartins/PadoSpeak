// Barra de formatação (negrito, itálico, sublinhado, riscado, cor e emoticons) que grava as tags no
// próprio texto. A mesma barra serve a caixa de mensagem, o nome e a mensagem pessoal.
import { useRef, useState } from 'react';
import { Bold, Italic, Underline, Strikethrough, Smile, Baseline } from 'lucide-react';
import { useStore } from '../store.js';
import { EmojiPicker, ColorPicker, editField, insertText } from './Emotes.jsx';

/**
 * `maxRaw`: tamanho máximo do texto com as tags (o servidor recusa acima disso).
 * `children`: botões extras no fim da barra (stickers, chamar atenção).
 */
export default function FormatTools({ inputRef, text, setText, maxRaw, children, label = 'Opções de texto' }) {
  const [open, setOpen] = useState(null); // 'emoji' | 'color'
  const colorBtn = useRef(null);
  const emojiBtn = useRef(null);
  // Não deixa a formatação passar do limite do campo.
  const guarded = (next) => {
    if (maxRaw && next.length > maxRaw) return useStore.getState().notify('Não cabe mais formatação neste texto', 'info');
    setText(next);
  };
  const wrap = (before, after, placeholder) => editField(inputRef.current, text, guarded, before, after, placeholder);
  const tools = [
    [Bold, 'Negrito', () => wrap('**', '**', 'negrito')],
    [Italic, 'Itálico', () => wrap('*', '*', 'itálico')],
    [Underline, 'Sublinhado', () => wrap('__', '__', 'sublinhado')],
    [Strikethrough, 'Riscado', () => wrap('~~', '~~', 'riscado')],
  ];
  return (
    <div className="composer-tools" role="toolbar" aria-label={label}>
      {tools.map(([Icon, name, fn]) => (
        <button key={name} type="button" className="gloss tool-sq" title={name} aria-label={name} onClick={fn}>
          <Icon size={15} />
        </button>
      ))}
      <span className="tool-wrap">
        <button
          ref={colorBtn}
          type="button"
          className={`gloss tool-sq${open === 'color' ? ' pressed' : ''}`}
          title="Cor do texto"
          aria-label="Cor do texto"
          aria-expanded={open === 'color'}
          onClick={() => setOpen(open === 'color' ? null : 'color')}
        >
          <Baseline size={15} className="ico-color" />
        </button>
        {open === 'color' && (
          <ColorPicker
            anchorRef={colorBtn}
            onClose={() => setOpen(null)}
            onPick={(hex) => {
              setOpen(null);
              wrap(`[cor=${hex}]`, '[/cor]', 'texto colorido');
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
