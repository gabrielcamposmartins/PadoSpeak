// Escolher o trecho de um som antes de enviar: a onda do arquivo com duas alças (início e fim), o
// trecho entre elas pode ser arrastado inteiro, e "Ouvir o trecho" toca só ele. No máximo 15 s: puxar
// uma alça além disso leva a outra junto.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Scissors } from 'lucide-react';
import { peaks, playClip, MAX_SOUND_SEC, MIN_SOUND_SEC } from '../lib/audioTrim.js';

const fmt = (s) => `${s.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Ajusta o trecho depois de mexer numa alça (`start`/`end`) ou no trecho todo (`move`). */
export function fitRange(kind, s, e, dur) {
  if (kind === 'move') {
    const len = e - s;
    s = clamp(s, 0, dur - len);
    return [s, s + len];
  }
  if (kind === 'start') {
    s = clamp(s, 0, e - MIN_SOUND_SEC);
    if (e - s > MAX_SOUND_SEC) e = s + MAX_SOUND_SEC;
  } else {
    e = clamp(e, s + MIN_SOUND_SEC, dur);
    if (e - s > MAX_SOUND_SEC) s = e - MAX_SOUND_SEC;
  }
  return [s, e];
}

export default function SoundTrimmer({ buffer, range, onChange, volume }) {
  const dur = buffer.duration;
  const [start, end] = range;
  const wave = useMemo(() => peaks(buffer), [buffer]);
  const box = useRef(null);
  const drag = useRef(null);
  const clip = useRef(null);
  const [head, setHead] = useState(null);

  const stop = () => {
    clip.current?.stop();
    clip.current = null;
    setHead(null);
  };
  useEffect(() => stop, []);
  // Mexeu no trecho: a prévia que estava tocando para (era do trecho antigo).
  useEffect(stop, [start, end]);

  useEffect(() => {
    if (head == null) return;
    const id = requestAnimationFrame(() => setHead(clip.current?.at() ?? null));
    return () => cancelAnimationFrame(id);
  }, [head]);

  const listen = () => {
    if (clip.current) return stop();
    clip.current = playClip(buffer, start, end, volume, () => {
      clip.current = null;
      setHead(null);
    });
    setHead(start);
  };

  const secAt = (clientX) => {
    const r = box.current.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * dur, 0, dur);
  };
  const down = (kind) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { kind, from: secAt(e.clientX), s: start, e: end };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const t = secAt(e.clientX);
    if (d.kind === 'move') onChange(fitRange('move', d.s + (t - d.from), d.e + (t - d.from), dur));
    else if (d.kind === 'start') onChange(fitRange('start', t, d.e, dur));
    else onChange(fitRange('end', d.s, t, dur));
  };
  const up = () => (drag.current = null);
  // Clique fora do trecho: leva a alça mais perto até ali.
  const jump = (e) => {
    const t = secAt(e.clientX);
    onChange(Math.abs(t - start) < Math.abs(t - end) ? fitRange('start', t, end, dur) : fitRange('end', start, t, dur));
  };
  const keys = (kind) => (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (delta == null) return;
    e.preventDefault();
    onChange(kind === 'start' ? fitRange('start', start + delta, end, dur) : fitRange('end', start, end + delta, dur));
  };

  const pct = (s) => `${(s / dur) * 100}%`;
  const len = end - start;
  return (
    <div className="trim">
      <div className="trim-label">
        <Scissors size={14} aria-hidden="true" />
        {dur > MAX_SOUND_SEC
          ? `O áudio tem ${fmt(dur)}: escolha o trecho de até ${MAX_SOUND_SEC} s que vai ficar.`
          : 'Arraste as pontas para cortar o começo ou o fim.'}
      </div>
      <div className="trim-box" ref={box} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerDown={jump}>
        <div className="trim-wave" aria-hidden="true">
          {wave.map((h, i) => {
            const t = ((i + 0.5) / wave.length) * dur;
            return <i key={i} className={t >= start && t <= end ? 'on' : ''} style={{ height: `${Math.max(6, Math.round(h * 100))}%` }} />;
          })}
        </div>
        <div className="trim-sel" style={{ left: pct(start), width: pct(len) }} onPointerDown={down('move')} title="Arraste para mover o trecho">
          <span
            className="trim-h start"
            role="slider"
            tabIndex={0}
            aria-label="Início do trecho"
            aria-valuemin={0}
            aria-valuemax={Math.round(dur * 10) / 10}
            aria-valuenow={Math.round(start * 10) / 10}
            aria-valuetext={fmt(start)}
            onPointerDown={down('start')}
            onKeyDown={keys('start')}
          />
          <span
            className="trim-h end"
            role="slider"
            tabIndex={0}
            aria-label="Fim do trecho"
            aria-valuemin={0}
            aria-valuemax={Math.round(dur * 10) / 10}
            aria-valuenow={Math.round(end * 10) / 10}
            aria-valuetext={fmt(end)}
            onPointerDown={down('end')}
            onKeyDown={keys('end')}
          />
        </div>
        {head != null && <span className="trim-head" style={{ left: pct(head) }} aria-hidden="true" />}
      </div>
      <div className="trim-foot">
        <button type="button" className="btn secondary trim-listen" onClick={listen}>
          {head != null ? <Square size={14} /> : <Play size={14} />} {head != null ? 'Parar' : 'Ouvir o trecho'}
        </button>
        <span className="trim-times">
          {fmt(start)} – {fmt(end)}
        </span>
        <span className={`trim-len${len >= MAX_SOUND_SEC - 0.05 ? ' max' : ''}`}>
          {fmt(len)} <small>de até {MAX_SOUND_SEC} s</small>
        </span>
      </div>
    </div>
  );
}
