// Anexos: arquivos, fotos e vídeos da câmera e stickers ficam acima da caixa de mensagem até o envio
// (o texto da caixa vai junto). Também a câmera e o gravador de mensagens de voz.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Send,
  X,
  Camera,
  Video,
  Circle,
  Square,
  SwitchCamera,
  RotateCcw,
  Trash2,
  Mic,
  FileText,
  FileArchive,
  File as FileIcon,
  TriangleAlert,
  Maximize2,
  Minimize2,
  Flashlight,
  FlashlightOff,
  Sun,
  Aperture,
} from 'lucide-react';
import { useStore, stickerHome, fileLimits } from '../store.js';
import { TitleBar } from './Aero.jsx';
import { StickerView } from './Stickers.jsx';
import { fmtSize, ttlWords, VoiceNote } from './Files.jsx';
import { useConn } from './conn.jsx';
import { isTouch } from '../lib/layout.js';
import { enterFullscreen, exitFullscreen, fullscreenElement, onFullscreenChange } from '../lib/fullscreen.js';

/** Texto que vai junto com um anexo (o servidor aceita até isso na legenda). */
export const CAPTION_MAX = 3500;

/** Primeiro formato que o navegador sabe gravar. */
const pickMime = (list) => list.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) || '';

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const mmss = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Janela sobre o app (fecha com Esc ou clicando fora). */
function Sheet({ title, onClose, className = '', children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <TitleBar title={`PadoSpeak — ${title}`} onClose={onClose} />
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Miniatura de um anexo na caixa de mensagem (imagem, vídeo, sticker ou cartão do arquivo). Arquivos
 * têm o botão "NSFW": marcado, quem receber vê borrado até clicar.
 */
function AttachTile({ item, big, onRemove, onNsfw }) {
  const file = item.kind === 'file' ? item.file : null;
  const url = useMemo(() => (file && /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
  const kind = file ? file.type.split('/')[0] : 'sticker';
  const name = file ? file.name : 'Sticker';
  const Icon = !file
    ? null
    : /zip|rar|7z|tar|gzip/.test(file.type) || /\.(zip|rar|7z|tar|gz)$/i.test(file.name)
      ? FileArchive
      : file.type.startsWith('text/')
        ? FileText
        : FileIcon;
  return (
    <div
      className={`attach-tile ${kind}${big ? ' big' : ''}${item.nsfw ? ' nsfw' : ''}`}
      title={file ? `${file.name} · ${fmtSize(file.size)}${item.nsfw ? ' · NSFW' : ''}` : 'Sticker'}
    >
      {item.kind === 'sticker' ? (
        <StickerView sticker={item.sticker} base={item.sticker.emote ? undefined : stickerHome().getState().baseUrl} />
      ) : kind === 'image' ? (
        <img src={url} alt={name} />
      ) : kind === 'video' ? (
        <>
          <video src={url} muted playsInline preload="metadata" />
          <span className="attach-play" aria-hidden="true">
            <Video size={14} />
          </span>
        </>
      ) : (
        <span className="attach-file">
          <Icon size={22} className="file-ico" />
          <span className="attach-name">{name}</span>
          <small>{fmtSize(file.size)}</small>
        </span>
      )}
      <button type="button" className="attach-x" onClick={onRemove} aria-label={`Tirar ${name}`} title="Tirar">
        <X size={12} />
      </button>
      {file && (
        <button
          type="button"
          className="attach-nsfw"
          onClick={onNsfw}
          aria-pressed={Boolean(item.nsfw)}
          aria-label={`Marcar ${name} como NSFW`}
          title={item.nsfw ? 'NSFW: aparece borrado até clicar (clique para desmarcar)' : 'Marcar como NSFW (aparece borrado até clicar)'}
        >
          NSFW
        </button>
      )}
    </div>
  );
}

/** Arquivos que passam do máximo (não dá para enviar), numa conversa privada (`dm`) ou num servidor. */
export function oversized(items, config, dm) {
  const { maxSize } = fileLimits(config, dm);
  return items.filter((i) => i.kind === 'file' && i.file.size > maxSize).map((i) => i.file);
}

/**
 * Anexos esperando o envio, acima da caixa de mensagem: o texto escrito na caixa vai junto ao enviar.
 * `items`: `{ kind: 'file', file }` ou `{ kind: 'sticker', sticker }`. `dm`: conversa privada (os
 * limites dos arquivos são outros).
 */
export function AttachTray({ items, onRemove, onClear, onNsfw, dm }) {
  const config = useConn()((s) => s.config);
  const { maxFile, maxSize, bigTtlMs, maxCount, pool } = fileLimits(config, dm);
  if (!items.length) return null;
  const files = items.filter((i) => i.kind === 'file').map((i) => i.file);
  const bigs = files.filter((f) => f.size > maxFile);
  const tooBig = files.filter((f) => f.size > maxSize);
  const one = bigs.length === 1;
  return (
    <div className="attach-tray" role="group" aria-label="Anexos para enviar">
      <div className="attach-row">
        {items.map((it, i) => (
          <AttachTile
            key={it.key}
            item={it}
            big={it.kind === 'file' && it.file.size > maxFile}
            onRemove={() => onRemove(i)}
            onNsfw={() => onNsfw(i)}
          />
        ))}
        {items.length > 1 && (
          <button type="button" className="gloss mini attach-clear" onClick={onClear} title="Tirar todos" aria-label="Tirar todos os anexos">
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {bigs.length > 0 && (
        <p className={`sp-warn${tooBig.length ? ' bad' : ''}`} role="status">
          <TriangleAlert size={15} />
          {tooBig.length
            ? `${tooBig.map((f) => f.name).join(', ')} passa de ${fmtSize(maxSize)}, o máximo aqui.`
            : `${one ? 'Este arquivo passa' : 'Estes arquivos passam'} de ${fmtSize(maxFile)}: ${
                bigTtlMs
                  ? `${one ? 'fica disponível' : 'ficam disponíveis'} só por ${ttlWords(bigTtlMs)} e depois some${one ? '' : 'm'} da conversa`
                  : `${one ? 'conta' : 'contam'} como arquivo grande`
              } (o servidor guarda até ${maxCount} arquivos grandes de cada vez, somando ${fmtSize(pool)}).`}
        </p>
      )}
    </div>
  );
}

/** Mensagem de erro da câmera/microfone que diz o que fazer. */
export function mediaError(e, what = 'câmera') {
  if (!window.isSecureContext) return `O navegador só libera a ${what} em HTTPS.`;
  if (e?.name === 'NotAllowedError') return `Permissão para usar a ${what} foi negada.`;
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return `Nenhum${what === 'câmera' ? 'a câmera' : ' microfone'} encontrad${what === 'câmera' ? 'a' : 'o'}.`;
  if (e?.name === 'NotReadableError' || e?.name === 'AbortError')
    return `A ${what} está em uso por outro programa (ou por uma chamada).`;
  return `${what[0].toUpperCase()}${what.slice(1)}: ${e?.message || e}`;
}

const VIDEO_MAX_MS = 3 * 60 * 1000;

/** Foto ou vídeo da câmera do celular: ganha o mesmo nome da câmera do PadoSpeak (foto-AAAAMMDD-HHMMSS.jpg). */
export function fromPhoneCamera(file) {
  const kind = file.type.startsWith('video/') ? 'video' : 'foto';
  const ext = (file.name.match(/\.(\w+)$/)?.[1] || (kind === 'video' ? 'mp4' : 'jpg')).toLowerCase();
  return new File([file], `${kind}-${stamp()}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

const clamp = (v, r) => Math.min(r.max, Math.max(r.min, v));
const fmtZoom = (z) => `${(Math.round(z * 10) / 10).toString().replace('.', ',')}×`;
const BACK_LENS = /back|rear|traseir|environment/i;
const FRONT_LENS = /front|frontal|user/i;

/**
 * Ajustes da câmera que o aparelho oferecer (no Android, o Chrome mostra quase todos): zoom (abaixo de
 * 1× é a grande-angular), lanterna, brilho e foco no toque. O que a câmera não tiver não aparece.
 */
function useCameraControls(stream) {
  const [caps, setCaps] = useState(null);
  const [zoom, setZoomState] = useState(1);
  const [torch, setTorch] = useState(false);
  const [exposure, setExposureState] = useState(0);
  const track = stream?.getVideoTracks()[0] || null;

  useEffect(() => {
    setCaps(null);
    setTorch(false);
    if (!track?.getCapabilities) return;
    let alive = true;
    let tries = 0;
    // O Chrome do Android às vezes só conta o que a câmera faz um instante depois de abrir.
    const read = () => {
      if (!alive) return;
      const c = track.getCapabilities() || {};
      const st = track.getSettings?.() || {};
      const range = (r) => (r && r.max > r.min ? { min: r.min, max: r.max, step: r.step || 0.1 } : null);
      const next = {
        zoom: range(c.zoom),
        torch: Boolean(c.torch),
        exposure: range(c.exposureCompensation),
        focus: Array.isArray(c.focusMode) && c.focusMode.includes('single-shot'),
      };
      if (!next.zoom && !next.torch && !next.exposure && tries++ < 3) return void setTimeout(read, 400);
      setCaps(next);
      setZoomState(st.zoom ?? 1);
      setExposureState(st.exposureCompensation ?? 0);
    };
    read();
    return () => {
      alive = false;
    };
  }, [track]);

  const apply = (c) => track?.applyConstraints({ advanced: [c] }).catch(() => {});
  // A pinça muda o zoom muitas vezes por quadro: aplica só o último valor.
  const pending = useRef(null);
  const setZoom = (z) => {
    if (!caps?.zoom) return;
    const v = clamp(z, caps.zoom);
    setZoomState(v);
    if (pending.current == null)
      requestAnimationFrame(() => {
        apply({ zoom: pending.current });
        pending.current = null;
      });
    pending.current = v;
  };
  return {
    caps,
    zoom,
    setZoom,
    torch,
    toggleTorch: () => {
      apply({ torch: !torch });
      setTorch(!torch);
    },
    exposure,
    setExposure: (v) => {
      setExposureState(v);
      apply({ exposureCompensation: v });
    },
    focusAt: (x, y) => caps?.focus && apply({ focusMode: 'single-shot', pointsOfInterest: [{ x, y }] }),
  };
}

/** Atalhos de zoom como os da câmera do celular: a grande-angular (se houver), 1×, 2×, 5× e 10×. */
function zoomStops(r) {
  const stops = [r.min < 1 ? r.min : null, 1, 2, 5, 10].filter((z) => z != null && z >= r.min && z <= r.max);
  return [...new Set(stops.map((z) => Math.round(z * 10) / 10))];
}

/**
 * Câmera para tirar uma foto ou gravar um vídeo e mandar na conversa. `onDone(file)` com o
 * resultado (vai para a prévia antes de enviar). `rear`: começa pela câmera de trás (celular);
 * `fullScreen`: já abre ocupando a tela.
 */
export function CameraCapture({ onDone, onClose, rear = false, fullScreen = false }) {
  const video = useRef(null);
  const [stream, setStream] = useState(null);
  const [mode, setMode] = useState('photo'); // photo | video
  const [full, setFull] = useState(fullScreen); // tela cheia
  const [error, setError] = useState('');
  const [devices, setDevices] = useState([]);
  const [deviceIdx, setDeviceIdx] = useState(0);
  const [facing, setFacing] = useState(rear ? 'environment' : 'user');
  const [lens, setLens] = useState(null); // outra lente do mesmo lado (deviceId), quando há mais de uma
  const [exposureOpen, setExposureOpen] = useState(false);
  const [focusDot, setFocusDot] = useState(null);
  const [rec, setRec] = useState(null); // { recorder, started, chunks, mic }
  const [now, setNow] = useState(Date.now());
  const [flash, setFlash] = useState(false);
  const saved = useStore.getState().prefs.devices?.camera;

  // Abre (ou troca) a câmera.
  useEffect(() => {
    let alive = true;
    let opened = null;
    setError('');
    const constraints = isTouch
      ? lens
        ? { deviceId: { exact: lens } }
        : { facingMode: { ideal: facing } }
      : devices[deviceIdx]
        ? { deviceId: { exact: devices[deviceIdx].deviceId } }
        : saved
          ? { deviceId: { ideal: saved } }
          : {};
    navigator.mediaDevices
      // No celular, a foto sai na resolução boa da câmera (o vídeo continua leve pelo bitrate da gravação).
      // `zoom: true` pede o zoom da câmera (sem ele o Chrome pode esconder o controle).
      ?.getUserMedia({
        video: {
          ...constraints,
          width: { ideal: isTouch ? 1920 : 1280 },
          height: { ideal: isTouch ? 1080 : 720 },
          ...(isTouch ? { zoom: true } : {}),
        },
      })
      .then(async (s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        opened = s;
        setStream(s);
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        if (alive && list.length !== devices.length) setDevices(list);
      })
      .catch((e) => alive && setError(mediaError(e)));
    if (!navigator.mediaDevices) setError(mediaError(null));
    return () => {
      alive = false;
      opened?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceIdx, facing, lens]);
  const ctl = useCameraControls(stream);

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream]);

  // Cronômetro da gravação (e para sozinho no limite).
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - rec.started >= VIDEO_MAX_MS) stopVideo();
    }, 250);
    return () => clearInterval(t);
  }, [rec]);

  const mirrored = isTouch ? facing === 'user' : true;

  const takePhoto = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    canvas.toBlob(
      (blob) => blob && onDone(new File([blob], `foto-${stamp()}.jpg`, { type: 'image/jpeg' })),
      'image/jpeg',
      0.92,
    );
  };

  const startVideo = async () => {
    if (!stream) return;
    let mic = null;
    try {
      const micId = useStore.getState().prefs.devices?.mic;
      mic = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { ideal: micId } } : true });
    } catch {
      useStore.getState().notify('Sem microfone: o vídeo vai sem som.', 'info');
    }
    const tracks = [...stream.getVideoTracks(), ...(mic?.getAudioTracks() || [])];
    const mimeType = pickMime([
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]);
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 });
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      return setError(`Não foi possível gravar vídeo aqui: ${e.message}`);
    }
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      mic?.getTracks().forEach((t) => t.stop());
      const type = recorder.mimeType || mimeType || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: type.split(';')[0] });
      if (blob.size) onDone(new File([blob], `video-${stamp()}.${ext}`, { type: blob.type }));
    };
    recorder.start(1000);
    setRec({ recorder, started: Date.now() });
    setNow(Date.now());
  };

  function stopVideo() {
    if (rec?.recorder.state === 'recording') rec.recorder.stop();
    setRec(null);
  }

  const canFlip = isTouch || devices.length > 1;
  const flip = () => {
    if (isTouch) {
      setLens(null);
      setFacing((f) => (f === 'user' ? 'environment' : 'user'));
    } else setDeviceIdx((i) => (i + 1) % devices.length);
  };
  // Lentes do lado em uso (o Android lista a grande-angular e a teleobjetiva como câmeras à parte).
  const lenses = isTouch ? devices.filter((d) => (facing === 'environment' ? BACK_LENS : FRONT_LENS).test(d.label)) : [];
  const nextLens = () => {
    const cur = lenses.findIndex((d) => d.deviceId === (lens || stream?.getVideoTracks()[0]?.getSettings?.().deviceId));
    setLens(lenses[(cur + 1) % lenses.length].deviceId);
  };

  // Pinça para o zoom e toque para focar, direto na imagem.
  const touches = useRef(new Map());
  const pinch = useRef(null);
  const stageEvents = {
    onPointerDown: (e) => {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (touches.current.size === 2 && ctl.caps?.zoom) {
        const [a, b] = [...touches.current.values()];
        pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: ctl.zoom };
      }
    },
    onPointerMove: (e) => {
      const t = touches.current.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX;
      t.y = e.clientY;
      if (pinch.current && touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        ctl.setZoom(pinch.current.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d));
      }
    },
    onPointerUp: (e) => {
      const t = touches.current.get(e.pointerId);
      touches.current.delete(e.pointerId);
      if (pinch.current) {
        if (!touches.current.size) pinch.current = null;
        return;
      }
      if (!t || Math.hypot(t.x - t.sx, t.y - t.sy) > 10 || !ctl.caps?.focus || !video.current) return;
      const r = video.current.getBoundingClientRect();
      let x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      const box = e.currentTarget.getBoundingClientRect();
      setFocusDot({ x: e.clientX - box.left, y: e.clientY - box.top, k: Date.now() });
      if (mirrored) x = 1 - x;
      ctl.focusAt(x, y);
    },
    onPointerCancel: (e) => {
      touches.current.delete(e.pointerId);
      if (!touches.current.size) pinch.current = null;
    },
  };
  useEffect(() => {
    if (!focusDot) return;
    const t = setTimeout(() => setFocusDot(null), 900);
    return () => clearTimeout(t);
  }, [focusDot]);
  // Os controles por cima da imagem não contam como toque para focar.
  const own = { onPointerDown: (e) => e.stopPropagation(), onPointerUp: (e) => e.stopPropagation() };

  // Tela cheia: a janela ocupa a tela toda (e, onde o navegador deixa, some a barra dele também).
  useEffect(() => {
    const stop = onFullscreenChange(() => !fullscreenElement() && setFull(false));
    return () => {
      stop();
      exitFullscreen();
    };
  }, []);
  const toggleFull = () => {
    if (full) {
      setFull(false);
      exitFullscreen();
    } else {
      setFull(true);
      // Sem o player nativo: a câmera precisa dos botões de gravar por cima.
      enterFullscreen(document.documentElement, null);
    }
  };

  return (
    <Sheet
      title={mode === 'photo' ? 'Tirar foto' : 'Gravar vídeo'}
      onClose={() => {
        if (rec) {
          rec.recorder.onstop = null;
          rec.recorder.stop();
        }
        onClose();
      }}
      className={`camera-sheet${full ? ' full' : ''}`}
    >
      <div className="cam-stage" {...stageEvents}>
        {error ? (
          <p className="cam-error">{error}</p>
        ) : (
          <video ref={video} className={`cam-video${mirrored ? ' mirror' : ''}`} autoPlay playsInline muted />
        )}
        {flash && <div className="cam-flash" />}
        {focusDot && <span key={focusDot.k} className="cam-focus" style={{ left: focusDot.x, top: focusDot.y }} />}
        {stream && !error && (ctl.caps?.torch || ctl.caps?.exposure || lenses.length > 1) && (
          <div className="cam-tools" {...own}>
            {ctl.caps?.torch && (
              <button
                type="button"
                className={`cam-tool${ctl.torch ? ' on' : ''}`}
                title={ctl.torch ? 'Apagar a lanterna' : 'Acender a lanterna'}
                aria-label="Lanterna"
                aria-pressed={ctl.torch}
                onClick={ctl.toggleTorch}
              >
                {ctl.torch ? <Flashlight size={18} /> : <FlashlightOff size={18} />}
              </button>
            )}
            {ctl.caps?.exposure && (
              <button
                type="button"
                className={`cam-tool${exposureOpen ? ' on' : ''}`}
                title="Brilho"
                aria-label="Brilho"
                aria-pressed={exposureOpen}
                onClick={() => setExposureOpen((v) => !v)}
              >
                <Sun size={18} />
              </button>
            )}
            {lenses.length > 1 && !rec && (
              <button
                type="button"
                className="cam-tool"
                title="Trocar a lente (grande-angular, normal, teleobjetiva)"
                aria-label="Trocar a lente"
                onClick={nextLens}
              >
                <Aperture size={18} />
              </button>
            )}
          </div>
        )}
        {exposureOpen && ctl.caps?.exposure && (
          <label className="cam-exposure" {...own}>
            <Sun size={14} />
            <input
              type="range"
              min={ctl.caps.exposure.min}
              max={ctl.caps.exposure.max}
              step={ctl.caps.exposure.step}
              value={ctl.exposure}
              aria-label="Brilho"
              onChange={(e) => ctl.setExposure(Number(e.target.value))}
            />
            <span>
              {ctl.exposure > 0 ? '+' : ''}
              {(Math.round(ctl.exposure * 10) / 10).toString().replace('.', ',')}
            </span>
          </label>
        )}
        {stream && !error && ctl.caps?.zoom && (
          <div className="cam-zoom" {...own}>
            <div className="cam-zoom-stops" role="group" aria-label="Zoom">
              {zoomStops(ctl.caps.zoom).map((z) => (
                <button
                  key={z}
                  type="button"
                  className={Math.abs(ctl.zoom - z) < 0.05 ? 'on' : undefined}
                  aria-label={`Zoom ${fmtZoom(z)}`}
                  onClick={() => ctl.setZoom(z)}
                >
                  {fmtZoom(z)}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={ctl.caps.zoom.min}
              max={ctl.caps.zoom.max}
              step={ctl.caps.zoom.step}
              value={ctl.zoom}
              aria-label="Zoom"
              onChange={(e) => ctl.setZoom(Number(e.target.value))}
            />
            {!zoomStops(ctl.caps.zoom).some((z) => Math.abs(ctl.zoom - z) < 0.05) && (
              <span className="cam-zoom-now">{fmtZoom(ctl.zoom)}</span>
            )}
          </div>
        )}
        {rec && (
          <span className="cam-rec" role="timer">
            <i /> {mmss(now - rec.started)} / {mmss(VIDEO_MAX_MS)}
          </span>
        )}
      </div>
      <div className="cam-bar">
        <div className="cam-modes" role="radiogroup" aria-label="Modo da câmera">
          {[
            ['photo', Camera, 'Foto'],
            ['video', Video, 'Vídeo'],
          ].map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={`cam-mode${mode === id ? ' on' : ''}`}
              disabled={Boolean(rec)}
              onClick={() => setMode(id)}
              title={label}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`cam-shutter${mode === 'video' ? ' video' : ''}${rec ? ' recording' : ''}`}
          disabled={!stream || Boolean(error)}
          aria-label={mode === 'photo' ? 'Tirar foto' : rec ? 'Parar gravação' : 'Começar a gravar'}
          title={mode === 'photo' ? 'Tirar foto' : rec ? 'Parar gravação' : 'Começar a gravar'}
          onClick={() => (mode === 'photo' ? takePhoto() : rec ? stopVideo() : startVideo())}
        >
          {mode === 'photo' ? <Circle size={30} /> : rec ? <Square size={22} /> : <Circle size={30} />}
        </button>
        <div className="cam-side">
          <button
            type="button"
            className="gloss mini"
            title={full ? 'Sair da tela cheia' : 'Tela cheia'}
            aria-label={full ? 'Sair da tela cheia' : 'Tela cheia'}
            aria-pressed={full}
            onClick={toggleFull}
          >
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          {canFlip && (
            <button type="button" className="gloss mini" title="Trocar câmera" aria-label="Trocar câmera" disabled={Boolean(rec)} onClick={flip}>
              <SwitchCamera size={16} />
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

const VOICE_MAX_MS = 10 * 60 * 1000;

/** Safari (Mac, iPhone e iPad, inclusive os outros navegadores do iPhone): grava e toca melhor em MP4. */
const webkit = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
const VOICE_MIMES = webkit
  ? ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm']
  : ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

/** Microfone pedido no próprio toque do botão (no iPhone, fora do toque o pedido pode não abrir). */
let pendingMic = null;
export function requestMic() {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) {
    pendingMic = Promise.reject(Object.assign(new Error('este navegador não deixa gravar áudio aqui.'), { name: 'NotSupportedError' }));
  } else {
    const base = { echoCancellation: true, noiseSuppression: true };
    const micId = useStore.getState().prefs.devices?.mic;
    pendingMic = md
      .getUserMedia({ audio: micId ? { ...base, deviceId: { ideal: micId } } : base })
      // microfone escolhido em outro aparelho (ou que sumiu): usa o padrão
      .catch((e) => (micId && e?.name !== 'NotAllowedError' ? md.getUserMedia({ audio: base }) : Promise.reject(e)));
  }
  pendingMic.catch(() => {});
  return pendingMic;
}
const takeMic = () => {
  const p = pendingMic || requestMic();
  pendingMic = null;
  return p;
};

/** Gravador do áudio, com o formato escolhido e, se o navegador recusar as opções, o padrão dele. */
function newRecorder(stream) {
  const mimeType = pickMime(VOICE_MIMES);
  for (const opts of [{ ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 }, mimeType ? { mimeType } : null, {}]) {
    if (!opts) continue;
    try {
      return { recorder: new MediaRecorder(stream, opts), mimeType: opts.mimeType || '' };
    } catch {
      /* tenta a próxima */
    }
  }
  throw Object.assign(new Error('este navegador não sabe gravar áudio.'), { name: 'NotSupportedError' });
}

/**
 * Gravador da mensagem de voz (no lugar da caixa de texto). Começa ao aparecer; "Parar" mostra a
 * prévia para ouvir antes de mandar. `onSend(blob, ms)` manda, `onCancel` descarta.
 */
export function VoiceRecorder({ onSend, onCancel }) {
  const [state, setState] = useState({ phase: 'starting' }); // starting | recording | review | error
  const [take, setTake] = useState(0); // gravar de novo recomeça
  const [now, setNow] = useState(Date.now());
  const [level, setLevel] = useState(0);
  const rec = useRef(null);
  const reviewUrl = useMemo(() => (state.phase === 'review' ? URL.createObjectURL(state.blob) : null), [state]);
  useEffect(() => () => reviewUrl && URL.revokeObjectURL(reviewUrl), [reviewUrl]);

  useEffect(() => {
    let alive = true;
    let ctx = null;
    let raf = 0;
    setState({ phase: 'starting' });
    takeMic()
      .then((stream) => {
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        let made;
        try {
          made = newRecorder(stream);
          // Sem fatias: no Safari, gravar em pedaços pode gerar um arquivo que não toca.
          made.recorder.start();
        } catch (e) {
          stream.getTracks().forEach((t) => t.stop());
          throw e;
        }
        const { recorder, mimeType } = made;
        const chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.current = { stream, recorder, chunks, started: Date.now(), mimeType };
        setState({ phase: 'recording' });
        // Medidor do volume (só para mostrar que está captando).
        try {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          ctx.resume?.().catch(() => {});
          const an = ctx.createAnalyser();
          an.fftSize = 256;
          ctx.createMediaStreamSource(stream).connect(an);
          const data = new Uint8Array(an.fftSize);
          const tick = () => {
            an.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            setLevel(peak / 128);
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch {
          /* sem medidor */
        }
      })
      .catch((e) => alive && setState({ phase: 'error', text: mediaError(e, 'microfone') }));
    const t = setInterval(() => {
      setNow(Date.now());
      if (rec.current && Date.now() - rec.current.started >= VOICE_MAX_MS) stop();
    }, 200);
    return () => {
      alive = false;
      clearInterval(t);
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => {});
      const r = rec.current;
      rec.current = null;
      if (r) {
        r.recorder.ondataavailable = null;
        r.recorder.onstop = null;
        if (r.recorder.state !== 'inactive') r.recorder.stop();
        r.stream.getTracks().forEach((tr) => tr.stop());
      }
    };
  }, [take]);

  /** Para de gravar e mostra a prévia (o microfone é solto). */
  function stop() {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const ms = Date.now() - r.started;
    r.recorder.onstop = () => {
      r.stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(r.chunks, { type: (r.recorder.mimeType || r.mimeType || 'audio/webm').split(';')[0] });
      if (ms < 500 || !blob.size) {
        useStore.getState().notify('Mensagem de voz curta demais.', 'info');
        return onCancel();
      }
      setState({ phase: 'review', blob, ms });
    };
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else r.recorder.onstop();
  }

  if (state.phase === 'error')
    return (
      <div className="voice-rec error" role="alert">
        <Mic size={16} /> <span>{state.text}</span>
        <button type="button" className="gloss mini" onClick={onCancel} aria-label="Fechar" title="Fechar">
          <X size={14} />
        </button>
      </div>
    );
  if (state.phase === 'review')
    return (
      <div className="voice-rec review" role="group" aria-label="Prévia da mensagem de voz">
        <button type="button" className="gloss mini danger-ico" onClick={onCancel} title="Descartar" aria-label="Descartar gravação">
          <Trash2 size={15} />
        </button>
        <VoiceNote voice={{ id: 'previa', duration: state.ms }} src={reviewUrl} />
        <button type="button" className="gloss mini" onClick={() => {
            requestMic();
            setTake((n) => n + 1);
          }} title="Gravar de novo" aria-label="Gravar de novo">
          <RotateCcw size={15} />
        </button>
        <button type="button" className="go send-btn" onClick={() => onSend(state.blob, state.ms)} title="Enviar mensagem de voz" aria-label="Enviar mensagem de voz">
          <Send size={16} /> Enviar
        </button>
      </div>
    );
  const elapsed = rec.current ? now - rec.current.started : 0;
  return (
    <div className="voice-rec" role="group" aria-label="Gravando mensagem de voz">
      <button type="button" className="gloss mini danger-ico" onClick={onCancel} title="Descartar" aria-label="Descartar gravação">
        <Trash2 size={15} />
      </button>
      <span className={`rec-dot${state.phase === 'recording' ? ' on' : ''}`} />
      <span className="rec-time">{state.phase === 'recording' ? mmss(elapsed) : 'Abrindo o microfone…'}</span>
      <span className="rec-level" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.min(1, level * 2.2).toFixed(2)})` }} />
      </span>
      <button
        type="button"
        className="stop rec-stop"
        onClick={stop}
        disabled={state.phase !== 'recording'}
        title="Parar de gravar (e ouvir antes de mandar)"
        aria-label="Parar de gravar"
      >
        <Square size={13} fill="currentColor" /> Parar
      </button>
    </div>
  );
}
