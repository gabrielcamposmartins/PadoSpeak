// Arquivos nas conversas: imagem e vídeo aparecem direto, texto mostra o começo, o resto vira um
// cartão para baixar. A mensagem guarda `[arquivo:<id>:<tamanho>:<tipo>:<nome>]` (e, na linha de
// baixo, o texto que foi junto). Mensagens de voz: `[voz:<id>:<duração ms>:<tipo>]`.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ArrowDown, FileText, FileArchive, File as FileIcon, X, ExternalLink, Play, Pause, Timer, ZoomIn, ZoomOut } from 'lucide-react';
import { startDownload, useDownload, useDownloads, percent } from '../lib/download.js';
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

/** Velocidades das mensagens de voz (o botão passa de uma para a outra). */
const SPEEDS = [1, 1.25, 1.5, 2];
const fmtRate = (r) => `${r.toLocaleString('pt-BR')}×`;

/** Mensagem de voz: tocar/pausar, a onda (clique para pular) e a velocidade. */
/** `src`: tocar outro endereço (ex.: a prévia da gravação, antes de mandar). */
export function VoiceNote({ voice, src }) {
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
        title="Velocidade (clique para trocar)"
        aria-label={`Velocidade: ${fmtRate(rate)}`}
        onClick={() => {
          const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
          setRate(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
      >
        {fmtRate(rate)}
      </button>
      <audio
        ref={audio}
        src={src || fileUrl(voice.id)}
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

/**
 * Botão de baixar com retorno: enquanto baixa, uma setinha verde animada (e a porcentagem, se `label`).
 * `size`: tamanho do arquivo, para a porcentagem.
 */
export function DownloadLink({ href, name, size = 0, iconSize = 15, label, className = '', title, ...rest }) {
  const d = useDownload(href);
  const pct = percent(d);
  const busy = Boolean(d);
  return (
    <a
      {...rest}
      className={`${className}${busy ? ' downloading' : ''}`}
      href={href}
      download={name}
      title={busy ? `Baixando ${name}${pct != null ? ` · ${pct}%` : '…'}` : title}
      aria-busy={busy || undefined}
      onClick={(e) => {
        e.preventDefault();
        startDownload(href, name, size);
      }}
    >
      {busy ? <ArrowDown size={iconSize} className="dl-arrow" /> : <Download size={iconSize} />}
      {label && (busy ? (pct != null ? ` ${pct}%` : ' Baixando…') : ` ${label}`)}
    </a>
  );
}

/** Downloads em andamento, no canto da tela (some quando terminam). */
export function DownloadsIndicator() {
  const list = useDownloads();
  if (!list.length) return null;
  return (
    <div className="dl-indicator" role="status" aria-live="polite">
      {list.map((d) => {
        const pct = percent(d);
        return (
          <div key={d.url} className="dl-item">
            <ArrowDown size={16} className="dl-arrow" />
            <span className="dl-name">{d.name}</span>
            <span className="dl-pct">{pct != null ? `${pct}%` : fmtSize(d.loaded)}</span>
            {pct != null && (
              <span className="dl-bar" aria-hidden="true">
                <i style={{ width: `${pct}%` }} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Programas e scripts não podem ser enviados soltos (o servidor recusa também); dentro de .zip pode. */
const BLOCKED = /\.(exe|msi|msp|bat|cmd|com|scr|pif|cpl|msc|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|run|bin|lnk|reg|dll|sys|drv|ocx|appx|msix|appxbundle|msixbundle|gadget|inf|elf|command|scf|url|iso|img|vhd|vhdx)$/i;
export const isBlockedFile = (name) => BLOCKED.test(name);

/** Imagem em tamanho grande, por cima de tudo (clique fora ou Esc fecha). Se ela encolheu para caber
 *  (comprida, larga ou grande demais), clicar amplia no ponto clicado e dá para arrastar (ou rolar,
 *  no toque) para ver as partes; outro clique volta a caber na tela. */
function Lightbox({ src, name, download, size, onClose }) {
  const box = useRef(null);
  const img = useRef(null);
  const drag = useRef(null);
  const [zoomTo, setZoomTo] = useState(0); // escala da ampliação; 0 = já cabe, não amplia
  const [zoom, setZoom] = useState(null); // { w, h, fx, fy, cx, cy } enquanto ampliada
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Ampliada: preenche a largura (imagem comprida) ou a altura (larga), pelo menos 2× o tamanho que
  // cabia, sem passar do tamanho real (a não ser que nem assim caiba).
  const measure = useCallback(() => {
    const el = img.current;
    if (!el?.naturalWidth || !box.current) return;
    const pad = getComputedStyle(el.parentElement);
    const aw = box.current.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const ah = box.current.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
    const sx = aw / el.naturalWidth;
    const sy = ah / el.naturalHeight;
    const fit = Math.min(1, sx, sy);
    const z = Math.min(1, Math.max(sx, sy, fit * 2));
    setZoomTo(z > fit * 1.05 ? z : 0);
  }, []);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Ao ampliar, o ponto clicado fica debaixo do cursor.
  useLayoutEffect(() => {
    if (!zoom) return;
    const el = img.current;
    box.current.scrollLeft = el.offsetLeft + zoom.fx * el.offsetWidth - zoom.cx;
    box.current.scrollTop = el.offsetTop + zoom.fy * el.offsetHeight - zoom.cy;
  }, [zoom]);

  const zoomIn = (e) => {
    const el = img.current;
    const r = el.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    const px = e ? e.clientX : r.left + r.width / 2;
    const py = e ? e.clientY : r.top + r.height / 2;
    setZoom({
      w: Math.round(el.naturalWidth * zoomTo),
      h: Math.round(el.naturalHeight * zoomTo),
      fx: (px - r.left) / r.width,
      fy: (py - r.top) / r.height,
      cx: px - b.left,
      cy: py - b.top,
    });
  };

  const onClick = (e) => {
    if (drag.current?.moved) return void (drag.current = null);
    if (zoom) return setZoom(null);
    if (e.target !== img.current) return onClose();
    if (zoomTo) zoomIn(e);
  };
  // Arrastar com o mouse rola a imagem ampliada (no toque, a rolagem nativa já faz isso).
  const onPointerDown = (e) => {
    if (!zoom || e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: box.current.scrollLeft, st: box.current.scrollTop, moved: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || d.done) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      box.current.setPointerCapture(e.pointerId);
      setGrabbing(true);
    }
    if (!d.moved) return;
    box.current.scrollLeft = d.sl - dx;
    box.current.scrollTop = d.st - dy;
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.done = true;
    if (!d.moved) drag.current = null;
    setGrabbing(false);
  };

  // No body: dentro da janela da conversa o `position: fixed` ficaria preso a ela.
  return createPortal(
    <div className={`lightbox${zoom ? ' zoomed' : ''}${grabbing ? ' grabbing' : ''}`} role="dialog" aria-label={name}>
      <div
        className="lightbox-scroll"
        ref={box}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="lightbox-stage">
          <img
            ref={img}
            src={src}
            alt={name}
            draggable={false}
            onLoad={measure}
            className={zoomTo && !zoom ? 'can-zoom' : undefined}
            style={zoom ? { width: zoom.w, height: zoom.h } : undefined}
            title={zoom ? 'Arraste para ver as partes · clique para voltar' : zoomTo ? 'Clique para ampliar' : undefined}
          />
        </div>
      </div>
      <div className="lightbox-bar">
        <span>{name}</span>
        {zoomTo > 0 && (
          <button
            className="gloss"
            onClick={() => (zoom ? setZoom(null) : zoomIn())}
            aria-label={zoom ? 'Ajustar à tela' : 'Ampliar'}
            title={zoom ? 'Ajustar à tela' : 'Ampliar'}
          >
            {zoom ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
          </button>
        )}
        <DownloadLink className="gloss" href={download} name={name} size={size} label="Baixar" />
        <button className="gloss" onClick={onClose} aria-label="Fechar">
          <X size={15} />
        </button>
      </div>
    </div>,
    document.body,
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
      <DownloadLink className="gloss mini" href={download} name={file.name} size={file.size} title="Baixar" aria-label={`Baixar ${file.name}`} />
    </div>
  );

  if (kind === 'image')
    return (
      <>
        <button type="button" className="file-image" onClick={() => setBig(true)} title={`${file.name} · ${fmtSize(file.size)}`}>
          <img src={src} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
        </button>
        {big && <Lightbox src={src} name={file.name} download={download} size={file.size} onClose={() => setBig(false)} />}
      </>
    );
  if (kind === 'video')
    return (
      <div className="file-video">
        <video src={src} controls preload="metadata" playsInline onError={() => setBroken(true)} />
        <span className="file-sub">
          {file.name} · {fmtSize(file.size)}
          <DownloadLink href={download} name={file.name} size={file.size} iconSize={13} title="Baixar" aria-label={`Baixar ${file.name}`} />
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
