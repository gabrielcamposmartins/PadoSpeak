import { useEffect, useState } from 'react';
import { activeVoiceConn } from '../store.js';

/** Latência até o servidor (última amostra), atualizada a cada 2 s durante uma chamada. */
export function useServerPing(active, store) {
  const [ms, setMs] = useState(null);
  useEffect(() => {
    if (!active) return setMs(null);
    const read = () => {
      const v = (store || activeVoiceConn()).getState().latencyHistory().samples.at(-1)?.server;
      setMs(v == null ? null : Math.round(v));
    };
    read();
    const t = setInterval(read, 2000);
    return () => clearInterval(t);
  }, [active]);
  return ms;
}
