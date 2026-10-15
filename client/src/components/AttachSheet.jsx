// Celular: menu rápido do clipe. Recentes (o que está copiado, o que veio pelo "Compartilhar", fotos da
// câmera, imagens coladas e os últimos arquivos das conversas) e, embaixo, Galeria / Câmera / Arquivos.
// O navegador não lê a galeria sozinho: a Galeria abre o seletor de fotos do sistema (o print mais novo
// aparece primeiro lá).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon, Camera, FolderOpen, ClipboardPaste, FileText, FileArchive, File as FileIcon, Video, LoaderCircle } from 'lucide-react';
import { useStore } from '../store.js';
import { useConn } from './conn.jsx';
import { parseFile } from './Files.jsx';
import { listRecent } from '../lib/recent.js';

const MAX_TILES = 12;

/** "14:02" hoje, "ontem", ou "15/10". */
function when(at) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === yesterday.toDateString()) return 'ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** Nome para mostrar (os arquivos gerados pelo app têm nomes com números). */
const label = (name) =>
  /^(copiado|colado)-\d+/.test(name) ? 'Imagem copiada' : /^foto-\d{8}/.test(name) ? 'Foto da câmera' : /^video-\d{8}/.test(name) ? 'Vídeo da câmera' : name;

const iconFor = (name, type) =>
  /zip|rar|7z|tar|gzip/.test(type) || /\.(zip|rar|7z|tar|gz)$/i.test(name) ? FileArchive : type.startsWith('text/') ? FileText : FileIcon;

/** Imagem copiada (se houver). Só lê se o navegador deixar. */
async function clipboardImage() {
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) {
      const blob = await item.getType(type);
      const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png';
      return new File([blob], `copiado-${Date.now()}.${ext}`, { type });
    }
  }
  return null;
}

function Thumb({ tile }) {
  const local = useMemo(() => (tile.blob && /^(image|video)\//.test(tile.type) ? URL.createObjectURL(tile.blob) : null), [tile]);
  useEffect(() => () => local && URL.revokeObjectURL(local), [local]);
  const src = local || tile.url;
  if (tile.kind === 'clip-ask') return <ClipboardPaste size={24} className="ico-blue" />;
  if (tile.type.startsWith('image/') && src) return <img src={src} alt="" loading="lazy" />;
  if (tile.type.startsWith('video/') && src)
    return (
      <>
        <video src={src} muted playsInline preload="metadata" />
        <span className="attach-play" aria-hidden="true">
          <Video size={13} />
        </span>
      </>
    );
  const Icon = iconFor(tile.name, tile.type);
  return <Icon size={24} className="file-ico" />;
}

/** `onFiles(files)`: vão para a faixa de anexos. `onCamera()`: abre a câmera. */
export default function AttachSheet({ target, onFiles, onCamera, onClose }) {
  const useC = useConn();
  const messages = useC((s) => s.messages);
  const fileUrl = useC((s) => s.fileUrl);
  const me = useC((s) => s.me?.id);
  const [local, setLocal] = useState([]);
  const [clip, setClip] = useState(null); // { file } com a imagem copiada, ou 'ask' (tocar para ler)
  const [busy, setBusy] = useState(null);
  const row = useRef(null);
  const touched = useRef(false); // a pessoa já rolou os recentes
  const gallery = useRef(null);
  const files = useRef(null);

  useEffect(() => {
    listRecent().then(setLocal);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Área de transferência: mostra a imagem copiada se o navegador já deixa ler; senão, um botão para ler.
    if (navigator.clipboard?.read) {
      setClip('ask');
      navigator.permissions
        ?.query({ name: 'clipboard-read' })
        .then((p) => p.state === 'granted' && clipboardImage().then((file) => setClip(file ? { file } : null)))
        .catch(() => {});
    }
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Últimos arquivos das conversas (mandados ou recebidos), fora mensagens de voz.
  const remote = useMemo(() => {
    const out = [];
    for (const list of Object.values(messages || {}))
      for (const m of list || []) {
        const f = parseFile(m.content);
        if (!f) continue;
        out.push({ kind: 'remote', key: `r-${f.id}`, id: f.id, name: f.name, type: f.mime, size: f.size, nsfw: f.nsfw, at: typeof m.createdAt === 'number' ? m.createdAt : Date.parse(m.createdAt) || 0, source: m.author?.id === me ? 'enviado' : 'recebido', url: fileUrl(f.id) });
      }
    // o mesmo arquivo (mandado de novo, por exemplo) aparece uma vez só, no mais recente
    const seen = new Set();
    return out
      .sort((a, b) => b.at - a.at)
      .filter((f) => !seen.has(`${f.name}|${f.size}`) && seen.add(`${f.name}|${f.size}`))
      .slice(0, MAX_TILES);
  }, [messages, fileUrl, me]);

  const tiles = useMemo(() => {
    const mine = local.map((f) => ({ ...f, kind: 'local', key: `l-${f.id}` }));
    const seen = new Set(mine.map((f) => `${f.name}|${f.size}`));
    const merged = [...mine, ...remote.filter((f) => !seen.has(`${f.name}|${f.size}`))].sort((a, b) => b.at - a.at);
    const head =
      clip === 'ask'
        ? [{ kind: 'clip-ask', key: 'clip', name: 'Copiado', type: '', source: 'tocar para ver' }]
        : clip?.file
          ? [{ kind: 'clip', key: 'clip', name: clip.file.name, type: clip.file.type, size: clip.file.size, blob: clip.file, source: 'copiado' }]
          : [];
    return [...head, ...merged].slice(0, MAX_TILES);
  }, [local, remote, clip]);

  // Os recentes chegam aos poucos (área de transferência, aparelho): fica no começo até a pessoa rolar.
  const tileKeys = tiles.map((t) => t.key).join();
  useLayoutEffect(() => {
    if (row.current && !touched.current) row.current.scrollLeft = 0;
  }, [tileKeys]);

  const done = (list) => {
    if (list.length) onFiles(list);
    onClose();
  };

  const pick = async (tile) => {
    if (busy) return;
    try {
      if (tile.kind === 'clip-ask') {
        setBusy(tile.key);
        const file = await clipboardImage();
        if (file) return done([file]);
        setClip(null);
        return useStore.getState().notify('Não há imagem copiada.', 'info');
      }
      if (tile.blob) return done([new File([tile.blob], tile.name, { type: tile.type })]);
      setBusy(tile.key);
      const res = await fetch(tile.url);
      if (!res.ok) throw new Error('o arquivo não está mais disponível');
      done([new File([await res.blob()], tile.name, { type: tile.type })]);
    } catch (e) {
      if (tile.kind === 'clip-ask') setClip(null);
      useStore.getState().notify(tile.kind === 'clip-ask' ? 'O navegador não deixou ver o que está copiado.' : `${tile.name}: ${e.message}`, 'info');
    } finally {
      setBusy(null);
    }
  };

  const fromInput = (e) => {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    done(list);
  };

  return createPortal(
    <div className="sheet-scrim" onClick={onClose}>
      <div className="attach-sheet" role="dialog" aria-label="Enviar arquivo" onClick={(e) => e.stopPropagation()}>
        <span className="sheet-grab" aria-hidden="true" />
        <h3>Enviar para {target}</h3>
        {tiles.length > 0 && (
          <>
            <div className="as-sec">Recentes</div>
            <div className="as-recent" role="list" ref={row} onTouchStart={() => (touched.current = true)} onWheel={() => (touched.current = true)}>
              {tiles.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="listitem"
                  className={`as-tile${t.kind === 'clip-ask' ? ' ask' : ''}`}
                  onClick={() => pick(t)}
                  disabled={Boolean(busy)}
                  aria-label={t.kind === 'clip-ask' ? 'Ver o que está copiado' : `${t.name} (${t.source})`}
                >
                  <span className={`as-thumb${t.nsfw ? ' nsfw' : ''}`}>{busy === t.key ? <LoaderCircle size={22} className="spin" /> : <Thumb tile={t} />}</span>
                  <span className="as-name">{t.kind === 'clip-ask' ? 'Copiado' : label(t.name)}</span>
                  <small>{t.at ? `${t.source} · ${when(t.at)}` : t.source}</small>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="as-actions">
          <button type="button" className="as-action" onClick={() => gallery.current?.click()}>
            <ImageIcon size={24} className="ico-green" />
            <span>Galeria</span>
            <small>fotos e vídeos</small>
          </button>
          <button
            type="button"
            className="as-action"
            onClick={() => {
              onClose();
              onCamera();
            }}
          >
            <Camera size={24} className="ico-blue" />
            <span>Câmera</span>
            <small>foto ou vídeo</small>
          </button>
          <button type="button" className="as-action" onClick={() => files.current?.click()}>
            <FolderOpen size={24} className="ico-gold" />
            <span>Arquivos</span>
            <small>PDF, zip, texto…</small>
          </button>
        </div>
        <input ref={gallery} type="file" accept="image/*,video/*" multiple hidden onChange={fromInput} />
        <input ref={files} type="file" multiple hidden onChange={fromInput} />
      </div>
    </div>,
    document.body,
  );
}
