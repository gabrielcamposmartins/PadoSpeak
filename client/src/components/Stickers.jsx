// Stickers: janela de escolha (padrão Aero + coleção própria com GIFs) e a exibição na conversa.
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X, LoaderCircle } from 'lucide-react';
import { useStore, stickerHome, STICKER_RE } from '../store.js';
import { EMOTES, Emote, Floating } from './Emotes.jsx';
import { useConn } from './conn.jsx';

const MAX_BYTES = 2 * 1024 * 1024;

/** `{ emote }` ou `{ id }` (e o texto que foi junto) se a mensagem for um sticker. */
export function parseSticker(content) {
  const m = STICKER_RE.exec(content.trim());
  if (!m) return null;
  return m[1] ? { emote: m[2], caption: m[3] || '' } : { id: m[2], caption: m[3] || '' };
}

/** Sticker dentro da conversa (a imagem é do servidor da conversa). */
export function StickerView({ sticker }) {
  const base = useConn()((s) => s.baseUrl);
  const [broken, setBroken] = useState(false);
  if (sticker.emote) {
    return (
      <span className="sticker" role="img" aria-label="Sticker">
        <Emote code={sticker.emote} size={96} />
      </span>
    );
  }
  if (broken) return <span className="sticker-missing">Sticker indisponível</span>;
  return (
    <img
      className="sticker sticker-img"
      src={`${base}/api/stickers/${sticker.id}/image`}
      alt="Sticker"
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

/** Janela de stickers: aba "Padrão" (emoticons Aero grandes) e "Meus" (coleção, com GIFs). */
export function StickerPicker({ anchorRef, onPick, onClose }) {
  const home = stickerHome();
  const mine = home((s) => s.stickers);
  const base = home((s) => s.baseUrl);
  const [tab, setTab] = useState('padrao');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (tab === 'meus' && mine == null) home.getState().loadStickers();
  }, [tab, mine, home]);

  async function add(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      for (const f of files) {
        if (f.size > MAX_BYTES) {
          useStore.getState().notify(`${f.name}: o sticker deve ter até 2 MB`);
          continue;
        }
        await home.getState().uploadSticker(f, f.name.replace(/\.[^.]+$/, ''));
      }
    } catch (err) {
      useStore.getState().notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Floating anchorRef={anchorRef} onClose={onClose} className="sticker-picker" role="dialog" aria-label="Stickers">
      <div className="aero-tabs" role="tablist" aria-label="Stickers">
        <button type="button" role="tab" aria-selected={tab === 'padrao'} className={`tab${tab === 'padrao' ? ' on' : ''}`} onClick={() => setTab('padrao')}>
          Padrão
        </button>
        <button type="button" role="tab" aria-selected={tab === 'meus'} className={`tab${tab === 'meus' ? ' on' : ''}`} onClick={() => setTab('meus')}>
          Meus stickers
        </button>
      </div>
      {tab === 'padrao' ? (
        <div className="sticker-grid">
          {EMOTES.map((e) => (
            <button key={e.code} type="button" className="sticker-tile" title={e.name} aria-label={`Sticker ${e.name}`} onClick={() => onPick({ emote: e.code })}>
              <Emote code={e.code} size={44} />
            </button>
          ))}
        </div>
      ) : (
        <div className="sticker-grid mine">
          <button
            type="button"
            className="sticker-tile add"
            title="Adicionar sticker (PNG, JPEG, WebP ou GIF animado, até 2 MB)"
            aria-label="Adicionar sticker"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {busy ? <LoaderCircle size={22} className="spin" /> : <ImagePlus size={22} />}
          </button>
          {mine == null && <span className="sticker-hint">Carregando…</span>}
          {(mine || []).map((st) => (
            <div key={st.id} className="sticker-tile-wrap">
              <button type="button" className="sticker-tile" title={st.name} aria-label={`Sticker ${st.name}`} onClick={() => onPick(st)}>
                <img src={`${base}${st.url}`} alt="" draggable={false} />
              </button>
              <button
                type="button"
                className="sticker-del"
                title="Tirar da coleção"
                aria-label={`Tirar ${st.name} da coleção`}
                onClick={() => home.getState().deleteSticker(st.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={add}
          />
        </div>
      )}
      <div className="popover-hint">
        {tab === 'padrao' ? 'Clique para escolher (dá para escrever algo junto antes de mandar).' : 'Seus stickers valem em todas as conversas · GIF animado também · até 2 MB.'}
      </div>
    </Floating>
  );
}
