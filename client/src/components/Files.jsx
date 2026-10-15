// Arquivos nas conversas: imagem e vídeo aparecem direto, texto mostra o começo, o resto vira um
// cartão para baixar. A mensagem guarda `[arquivo:<id>:<tamanho>:<tipo>:<nome>]` (e, na linha de
// baixo, o texto que foi junto). Mensagens de voz: `[voz:<id>:<duração ms>:<tipo>]`.
import { useEffect, useRef, useState } from 'react';
import { Download, FileText, FileArchive, File as FileIcon, X, ExternalLink, Play, Pause, Timer } from 'lucide-react';
import { FILE_RE, VOICE_RE } from '../store.js';
import { useConn } from './conn.jsx';

export const parseFile = (content) => {
  const m = FILE_RE.exec(content || '');
  return m ? { id: m[1], size: Number(m[2]), mime: m[3], name: m[4], caption: m[5] || '' } : null;
};

export const parseVoice = (content) => {
  const m = VOICE_RE.exec(content || '');
  return m ? { id: m[1], duration: Number(m[2]), mime: m[3] } : null;
};

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** "3 min", "2 h", "5 dias" até `at`. */
export function fmtLeft(at, now = Date.now()) {
  const ms = Math.max(0, at - now);
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} dias`;
}

/** Relógio que atualiza a cada `ms` (para contagens regressivas). */
export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Aviso "some em X" das mensagens com validade. */
export function ExpiresTag({ at }) {
  const now = useNow(at - Date.now() < 3600000 ? 15000 : 60000);
  return (
    <span className="expires-tag" title={`Some em ${new Date(at).toLocaleString('pt-BR')}`}>
      <Timer size={12} /> some em {fmtLeft(at, now)}
    </span>
  );
}

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Barrinhas da "onda" (fixas por mensagem, só para dar cara de áudio). */
function bars(id, n = 32) {
  let h = parseInt(id.slice(0, 8), 16) || 1;
  return Array.from({ length: n }, () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return 0.25 + (h % 1000) / 1333;
  });
}

/** Mensagem de voz: tocar/pausar, a onda (clique para pular) e a velocidade. */
export function VoiceNote({ voice }) {
  const useC = useConn();
  const fileUrl = useC((s) => s.fileUrl);
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState(1);
  const [broken, setBroken] = useState(false);
  const [dur, setDur] = useState(voice.duration);
  const wave = bars(voice.id);
  if (broken) return <span className="file-gone">Mensagem de voz indisponível</span>;
  const frac = dur ? Math.min(1, pos / dur) : 0;
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => setBroken(true));
    else a.pause();
  };
  return (
    <div className={`voice-note${playing ? ' playing' : ''}`}>
      <button type="button" className="gloss voice-play" onClick={toggle} aria-label={playing ? 'Pausar' : 'Ouvir mensagem de voz'}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div
        className="voice-wave"
        role="slider"
        aria-label="Posição"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur / 1000)}
        aria-valuenow={Math.round(pos / 1000)}
        tabIndex={0}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const a = audio.current;
          if (a && dur) a.currentTime = (((e.clientX - r.left) / r.width) * dur) / 1000;
        }}
      >
        {wave.map((h, i) => (
          <i key={i} className={i / wave.length < frac ? 'on' : ''} style={{ height: `${Math.round(h * 100)}%` }} />
        ))}
      </div>
      <span className="voice-time">{mmss(playing || pos ? pos : dur)}</span>
      <button
        type="button"
        className="voice-rate"
        title="Velocidade"
        onClick={() => {
          const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
          setRate(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
      >
        {rate}×
      </button>
      <audio
        ref={audio}
        src={fileUrl(voice.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPos(0);
        }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration * 1000)}
        onError={() => setBroken(true)}
      />
    </div>
  );
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
