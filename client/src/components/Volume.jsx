// Volume com ajuste fino: passos de 1%, o valor exato num campo (digite 37, por exemplo), a rodinha do
// mouse sobe/desce 1% e duplo clique volta a 100%.
import { useEffect, useRef } from 'react';

const clamp = (v, max) => Math.min(max, Math.max(0, Math.round(v * 100) / 100));

export default function VolumeSlider({ value, onChange, label, max = 1, className = '' }) {
  const range = useRef(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  // Rodinha: listener não passivo para não rolar a página junto.
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const { value: v, onChange: set } = latest.current;
      set(clamp(v + (e.deltaY < 0 ? 0.01 : -0.01), max));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [max]);
  const pct = Math.round(value * 100);
  return (
    <span className={`vol ${className}`}>
      <input
        ref={range}
        type="range"
        min="0"
        max={max}
        step="0.01"
        value={value}
        aria-label={label}
        title={`${label}: ${pct}% (rodinha do mouse ajusta 1%, duplo clique volta a 100%)`}
        onChange={(e) => onChange(clamp(Number(e.target.value), max))}
        onDoubleClick={() => onChange(1)}
      />
      <input
        type="number"
        className="vol-num"
        min="0"
        max={Math.round(max * 100)}
        step="1"
        value={pct}
        aria-label={`${label} em %`}
        onChange={(e) => e.target.value !== '' && onChange(clamp(Number(e.target.value) / 100, max))}
      />
      <span className="vol-unit">%</span>
    </span>
  );
}
