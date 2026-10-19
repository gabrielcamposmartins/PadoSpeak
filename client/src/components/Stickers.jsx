// Stickers: janela de escolha (padrão Aero + coleção própria com GIFs) e a exibição na conversa.
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X, LoaderCircle, BookmarkPlus, BookmarkCheck } from 'lucide-react';
import { PointMenu, Item } from './VoiceMenus.jsx';
import { useStore, useStickerHome, STICKER_RE } from '../store.js';
import { EMOTES, Emote, Floating } from './Emotes.jsx';
import { useConn } from './conn.jsx';
import { magicEmoteKind, playMagic } from '../lib/magic.js';

const MAX_BYTES = 2 * 1024 * 1024;

/** `{ emote }` ou `{ id }` (e o texto que foi junto) se a mensagem for um sticker. */
export function parseSticker(content) {
  const m = STICKER_RE.exec(content.trim());
  if (!m) return null;
  return m[1] ? { emote: m[2], caption: m[3] || '' } : { id: m[2], caption: m[3] || '' };
}

/**
 * Sticker dentro da conversa (a imagem é do servidor da conversa). `base`: outro endereço — a prévia de um
 * sticker da minha coleção antes de enviar, que mora onde a coleção mora (a conta no servidor; no app do
 * Windows sem o servidor, o perfil local).
 */
export function StickerView({ sticker, base: fromBase }) {
  const connBase = useConn()((s) => s.baseUrl);
  const base = fromBase || connBase;
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

/**
 * Sticker numa mensagem: clicar (ou botão direito) abre o menu para salvar na minha coleção. A imagem
 * vem do servidor da conversa e é enviada para a minha coleção (o servidor não duplica o mesmo sticker).
 */
export function MessageSticker({ sticker }) {
  const conn = useConn();
  const home = useStickerHome();
  const mine = home((s) => s.stickers);
  const [menu, setMenu] = useState(null); // { x, y }
  if (sticker.emote) {
    // Sticker de efeito (estrelas, bolhas, confete, arco-íris): passar o mouse solta o efeito.
    const fx = magicEmoteKind(sticker.emote);
    return fx ? (
      <span className="magic-emote" onMouseEnter={() => playMagic(fx)}>
        <StickerView sticker={sticker} />
      </span>
    ) : (
      <StickerView sticker={sticker} />
    );
  }
  const sameServer = conn === home;
  const already = sameServer && Boolean(mine?.some((x) => x.id === sticker.id));
  const open = (e) => {
    e.preventDefault();
    if (mine == null) home.getState().loadStickers().catch(() => {});
    const r = e.currentTarget.getBoundingClientRect();
    setMenu(e.type === 'contextmenu' || e.detail > 0 ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 });
  };
  const save = async () => {
    setMenu(null);
    const notify = useStore.getState().notify;
    try {
      const st = home.getState();
      const before = st.stickers ?? (await st.loadStickers().then(() => home.getState().stickers)) ?? [];
      const blob = await conn.getState().stickerBlob(sticker.id);
      const saved = await home.getState().uploadSticker(blob, 'Sticker salvo');
      if (before.some((x) => x.id === saved?.id)) notify('Esse sticker já está nos seus stickers.', 'info');
      else notify('Sticker salvo em “Meus stickers”.', 'info');
    } catch (err) {
      notify(`Sticker: ${err.message}`);
    }
  };
  return (
    <>
      <button
        type="button"
        className="sticker-btn"
        onClick={open}
        onContextMenu={open}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        aria-label="Sticker (opções)"
        title="Sticker: clique para salvar nos seus stickers"
      >
        <StickerView sticker={sticker} />
      </button>
      {menu && (
        <PointMenu x={menu.x} y={menu.y} label="Sticker" onClose={() => setMenu(null)}>
          {mine == null ? (
            <Item icon={LoaderCircle} disabled>
              Carregando…
            </Item>
          ) : already ? (
            <Item icon={BookmarkCheck} disabled>
              Já está nos seus stickers
            </Item>
          ) : (
            <Item icon={BookmarkPlus} onClick={save}>
              Salvar em meus stickers
            </Item>
          )}
        </PointMenu>
      )}
    </>
  );
}

/** Janela de stickers: aba "Padrão" (emoticons Aero grandes) e "Meus" (coleção, com GIFs). */
export function StickerPicker({ anchorRef, onPick, onClose }) {
  const home = useStickerHome();
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
