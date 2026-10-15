// Envios com confirmação: arquivos, fotos e vídeos da câmera e stickers aparecem numa prévia antes de
// ir para a conversa, com um texto opcional junto. Também o gravador de mensagens de voz.
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
} from 'lucide-react';
import { useStore } from '../store.js';
import { TitleBar } from './Aero.jsx';
import FormatTools, { formatKey } from './FormatTools.jsx';
import { StickerView } from './Stickers.jsx';
import { fmtSize } from './Files.jsx';
import { isTouch } from '../lib/layout.js';

const CAPTION_MAX = 3500;
/** Limites dos arquivos grandes (iguais aos do servidor, se ele não informar). */
const BIG = { ttlMs: 10 * 60 * 1000, maxCount: 3, maxTotal: 3 * 1024 ** 3 };

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

/** Prévia de um arquivo escolhido (imagem, vídeo, áudio ou cartão). */
function FilePreview({ file, big }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const kind = file.type.split('/')[0];
  if (kind === 'image') return <img className="sp-media" src={url} alt={file.name} />;
  if (kind === 'video') return <video className="sp-media" src={url} controls playsInline preload="metadata" />;
  const Icon = /zip|rar|7z|tar|gzip/.test(file.type) || /\.(zip|rar|7z|tar|gz)$/i.test(file.name) ? FileArchive : file.type.startsWith('text/') ? FileText : FileIcon;
  return (
    <div className="sp-file">
      <Icon size={30} className="file-ico" />
      <span className="sp-file-name" title={file.name}>
        {file.name}
      </span>
      <span className="sp-file-size">
        {fmtSize(file.size)}
        {big && ' · grande'}
      </span>
      {kind === 'audio' && <audio src={url} controls preload="metadata" />}
    </div>
  );
}

/**
 * Confirmação do envio. `items`: `{ kind: 'file', file }` ou `{ kind: 'sticker', sticker }`.
 * `onSend(caption)` envia; `onRetake` (câmera) volta para tirar outra.
 */
export function SendPreview({ items, target, onSend, onCancel, onRetake }) {
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const limits = useStore((s) => s.config?.files);
  const maxFile = limits?.maxFile || 25 * 1024 * 1024;
  const maxTotal = limits?.bigMaxTotal || BIG.maxTotal;
  const files = items.filter((i) => i.kind === 'file').map((i) => i.file);
  const bigs = files.filter((f) => f.size > maxFile);
  const tooBig = files.filter((f) => f.size > maxTotal);
  const what =
    items[0]?.kind === 'sticker'
      ? 'sticker'
      : files.length > 1
        ? `${files.length} arquivos`
        : files[0]?.type.startsWith('image/')
          ? 'foto'
          : files[0]?.type.startsWith('video/')
            ? 'vídeo'
            : 'arquivo';
  useEffect(() => {
    requestAnimationFrame(() => ref.current?.focus());
  }, []);
  const send = async () => {
    if (busy || tooBig.length) return;
    setBusy(true);
    try {
      await onSend(caption.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Enviar ${what}`} onClose={onCancel} className="send-preview">
      <div className="modal-body">
        <h2>
          Enviar {what} {target && <small>para {target}</small>}
        </h2>
        <div className={`sp-items${items.length > 1 ? ' many' : ''}`}>
          {items.map((it, i) =>
            it.kind === 'sticker' ? (
              <div className="sp-sticker" key="sticker">
                <StickerView sticker={it.sticker} />
              </div>
            ) : (
              <FilePreview key={`${it.file.name}-${i}`} file={it.file} big={it.file.size > maxFile} />
            ),
          )}
        </div>
        {bigs.length > 0 && (
          <p className={`sp-warn${tooBig.length ? ' bad' : ''}`} role="status">
            <TriangleAlert size={15} />
            {tooBig.length
              ? `${tooBig.map((f) => f.name).join(', ')} passa de ${fmtSize(maxTotal)}, o máximo para arquivos grandes.`
              : `${bigs.length === 1 ? 'Este arquivo passa' : 'Estes arquivos passam'} de ${fmtSize(maxFile)}: ${
                  bigs.length === 1 ? 'fica disponível' : 'ficam disponíveis'
                } só por ${Math.round((limits?.bigTtlMs || BIG.ttlMs) / 60000)} minutos e depois some${bigs.length === 1 ? '' : 'm'} da conversa (o servidor guarda até ${
                  limits?.bigMaxCount || BIG.maxCount
                } arquivos grandes de cada vez, somando ${fmtSize(maxTotal)}).`}
          </p>
        )}
        <div className="field sp-caption">
          <FormatTools inputRef={ref} text={caption} setText={setCaption} maxRaw={CAPTION_MAX} label="Formatação do texto" />
          <textarea
            ref={ref}
            rows={2}
            value={caption}
            maxLength={CAPTION_MAX}
            placeholder="Escreva algo para ir junto (opcional)"
            aria-label="Texto para enviar junto"
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => {
              if (formatKey(e, ref.current, caption, setCaption, CAPTION_MAX)) return;
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
      </div>
      <div className="modal-foot">
        {onRetake ? (
          <button type="button" className="btn ghost" onClick={onRetake} disabled={busy}>
            <RotateCcw size={16} /> Tirar outra
          </button>
        ) : (
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
        )}
        <button type="button" className="btn" onClick={send} disabled={busy || tooBig.length > 0}>
          <Send size={16} /> {busy ? 'Enviando…' : 'Enviar'}
        </button>
      </div>
    </Sheet>
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

/**
 * Câmera para tirar uma foto ou gravar um vídeo e mandar na conversa. `onDone(file)` com o
 * resultado (vai para a prévia antes de enviar).
 */
export function CameraCapture({ onDone, onClose }) {
  const video = useRef(null);
  const [stream, setStream] = useState(null);
  const [mode, setMode] = useState('photo'); // photo | video
  const [error, setError] = useState('');
  const [devices, setDevices] = useState([]);
  const [deviceIdx, setDeviceIdx] = useState(0);
  const [facing, setFacing] = useState('user');
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
      ? { facingMode: { ideal: facing } }
      : devices[deviceIdx]
        ? { deviceId: { exact: devices[deviceIdx].deviceId } }
        : saved
          ? { deviceId: { ideal: saved } }
          : {};
    navigator.mediaDevices
      ?.getUserMedia({ video: { ...constraints, width: { ideal: 1280 }, height: { ideal: 720 } } })
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
  }, [deviceIdx, facing]);

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
    if (isTouch) setFacing((f) => (f === 'user' ? 'environment' : 'user'));
    else setDeviceIdx((i) => (i + 1) % devices.length);
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
      className="camera-sheet"
    >
      <div className="cam-stage">
        {error ? (
          <p className="cam-error">{error}</p>
        ) : (
          <video ref={video} className={`cam-video${mirrored ? ' mirror' : ''}`} autoPlay playsInline muted />
        )}
        {flash && <div className="cam-flash" />}
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

/**
 * Gravador da mensagem de voz (no lugar da caixa de texto). Começa ao aparecer; `onSend(blob, ms)`
 * manda, `onCancel` descarta.
 */
export function VoiceRecorder({ onSend, onCancel }) {
  const [state, setState] = useState({ phase: 'starting' }); // starting | recording | error
  const [now, setNow] = useState(Date.now());
  const [level, setLevel] = useState(0);
  const rec = useRef(null);

  useEffect(() => {
    let alive = true;
    let ctx = null;
    let raf = 0;
    const micId = useStore.getState().prefs.devices?.mic;
    navigator.mediaDevices
      ?.getUserMedia({ audio: { ...(micId ? { deviceId: { ideal: micId } } : {}), echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        const mimeType = pickMime(['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']);
        const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000 });
        const chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        recorder.start(500);
        rec.current = { stream, recorder, chunks, started: Date.now(), mimeType };
        setState({ phase: 'recording' });
        // Medidor do volume (só para mostrar que está captando).
        try {
          ctx = new AudioContext();
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
      if (rec.current && Date.now() - rec.current.started >= VOICE_MAX_MS) finish(true);
    }, 200);
    return () => {
      alive = false;
      clearInterval(t);
      cancelAnimationFrame(raf);
      ctx?.close().catch(() => {});
      const r = rec.current;
      if (r) {
        r.recorder.ondataavailable = null;
        if (r.recorder.state !== 'inactive') r.recorder.stop();
        r.stream.getTracks().forEach((tr) => tr.stop());
      }
    };
  }, []);

  function finish(send) {
    const r = rec.current;
    rec.current = null;
    if (!r) return onCancel();
    const ms = Date.now() - r.started;
    r.recorder.onstop = () => {
      r.stream.getTracks().forEach((tr) => tr.stop());
      if (!send) return onCancel();
      const blob = new Blob(r.chunks, { type: (r.recorder.mimeType || r.mimeType || 'audio/webm').split(';')[0] });
      if (ms < 500 || !blob.size) {
        useStore.getState().notify('Mensagem de voz curta demais.', 'info');
        return onCancel();
      }
      onSend(blob, ms);
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
  const elapsed = rec.current ? now - rec.current.started : 0;
  return (
    <div className="voice-rec" role="group" aria-label="Gravando mensagem de voz">
      <button type="button" className="gloss mini danger-ico" onClick={() => finish(false)} title="Descartar" aria-label="Descartar gravação">
        <Trash2 size={15} />
      </button>
      <span className={`rec-dot${state.phase === 'recording' ? ' on' : ''}`} />
      <span className="rec-time">{state.phase === 'recording' ? mmss(elapsed) : 'Abrindo o microfone…'}</span>
      <span className="rec-level" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.min(1, level * 2.2).toFixed(2)})` }} />
      </span>
      <button
        type="button"
        className="go send-btn"
        onClick={() => finish(true)}
        disabled={state.phase !== 'recording'}
        title="Enviar mensagem de voz"
        aria-label="Enviar mensagem de voz"
      >
        <Send size={16} /> Enviar
      </button>
    </div>
  );
}
