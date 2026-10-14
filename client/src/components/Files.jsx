// Arquivos nas conversas: imagem e vídeo aparecem direto, texto mostra o começo, o resto vira um
// cartão para baixar. A mensagem guarda `[arquivo:<id>:<tamanho>:<tipo>:<nome>]`.
import { useEffect, useState } from 'react';
import { Download, FileText, FileArchive, File as FileIcon, X, ExternalLink } from 'lucide-react';
import { FILE_RE } from '../store.js';
import { useConn } from './conn.jsx';

export const parseFile = (content) => {
  const m = FILE_RE.exec(content || '');
  return m ? { id: m[1], size: Number(m[2]), mime: m[3], name: m[4] } : null;
};

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Programas e scripts não podem ser enviados soltos (o servidor recusa também); dentro de .zip pode. */
const BLOCKED = /\.(exe|msi|msp|bat|cmd|com|scr|pif|cpl|msc|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|run|bin|lnk|reg|dll|sys|drv|ocx|appx|msix|appxbundle|msixbundle|gadget|inf|elf|command|scf|url|iso|img|vhd|vhdx)$/i;
export const isBlockedFile = (name) => BLOCKED.test(name);

/** Imagem em tamanho grande, por cima de tudo (clique fora ou Esc fecha). */
function Lightbox({ src, name, download, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={name} onClick={onClose}>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{name}</span>
        <a className="gloss" href={download} download={name}>
          <Download size={15} /> Baixar
        </a>
        <button className="gloss" onClick={onClose} aria-label="Fechar">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

function TextPreview({ src }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(src, { headers: { range: 'bytes=0-4095' } })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
  }, [src]);
  if (text == null) return <pre className="file-text loading">Carregando…</pre>;
  const lines = text.split('\n');
  return <pre className="file-text">{lines.slice(0, 12).join('\n') + (lines.length > 12 || text.length >= 4096 ? '\n…' : '')}</pre>;
}

export function FileView({ file }) {
  const useC = useConn();
  const fileUrl = useC((s) => s.fileUrl);
  const [big, setBig] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = fileUrl(file.id);
  const download = fileUrl(file.id, true);
  const kind = file.mime.split('/')[0];

  if (broken) return <span className="file-gone">Arquivo removido: {file.name}</span>;

  const card = (Icon, extra) => (
    <div className="file-card">
      <Icon size={30} className="file-ico" />
      <div className="file-meta">
        <a href={src} target="_blank" rel="noreferrer" className="file-name" title={file.name}>
          {file.name}
        </a>
        <span>
          {fmtSize(file.size)}
          {extra}
        </span>
      </div>
      <a className="gloss mini" href={download} download={file.name} title="Baixar" aria-label={`Baixar ${file.name}`}>
        <Download size={15} />
      </a>
    </div>
  );

  if (kind === 'image')
    return (
      <>
        <button type="button" className="file-image" onClick={() => setBig(true)} title={`${file.name} · ${fmtSize(file.size)}`}>
          <img src={src} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
        </button>
        {big && <Lightbox src={src} name={file.name} download={download} onClose={() => setBig(false)} />}
      </>
    );
  if (kind === 'video')
    return (
      <div className="file-video">
        <video src={src} controls preload="metadata" playsInline onError={() => setBroken(true)} />
        <span className="file-sub">
          {file.name} · {fmtSize(file.size)}
          <a href={download} download={file.name} title="Baixar">
            <Download size={13} />
          </a>
        </span>
      </div>
    );
  if (kind === 'audio')
    return (
      <div className="file-audio">
        {card(FileIcon)}
        <audio src={src} controls preload="metadata" />
      </div>
    );
  if (file.mime === 'text/plain')
    return (
      <div className="file-textbox">
        {card(FileText, ' · texto')}
        <TextPreview src={src} />
      </div>
    );
  if (file.mime === 'application/pdf')
    return card(FileText, (
      <>
        {' · PDF · '}
        <a href={src} target="_blank" rel="noreferrer">
          abrir <ExternalLink size={11} />
        </a>
      </>
    ));
  return card(file.mime === 'application/zip' ? FileArchive : FileIcon);
}

/** Envios em andamento, acima da caixa de texto. */
export function UploadList({ uploads }) {
  if (!uploads.length) return null;
  return (
    <div className="uploads" aria-live="polite">
      {uploads.map((u) => (
        <div className="upload-row" key={u.key}>
          <span className="upload-name">{u.name}</span>
          <span className="upload-bar">
            <i style={{ width: `${Math.round((u.progress || 0) * 100)}%` }} />
          </span>
          <span className="upload-pct">{Math.round((u.progress || 0) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
