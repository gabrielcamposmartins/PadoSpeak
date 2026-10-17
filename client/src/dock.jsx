// Dock flutuante da transmissão (app do Windows): janela pequena, sempre por cima e fora da própria
// transmissão. Conversa com a janela principal por eventos (veja lib/shareDock.js).
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RefreshCw, Volume2, VolumeX, MonitorOff, ChevronDown, MonitorUp } from 'lucide-react';
import './dock.css';

const send = (action) => import('@tauri-apps/api/event').then(({ emitTo }) => emitTo('main', 'share-dock-action', action)).catch(() => {});

function ShareDock() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let off;
    import('@tauri-apps/api/event').then(async ({ listen, emitTo }) => {
      off = await listen('share-state', (e) => setS(e.payload));
      emitTo('main', 'share-dock-ready', null).catch(() => {});
    });
    return () => off?.();
  }, []);
  const muted = !s?.hasAudio || s?.audioMuted;
  return (
    <div className="dock" data-tauri-drag-region>
      <span className="dock-live" data-tauri-drag-region>
        <MonitorUp size={15} aria-hidden="true" />
        <span className="dock-text" data-tauri-drag-region>
          <b data-tauri-drag-region>Transmitindo</b>
          <span className="dock-label" title={s?.label} data-tauri-drag-region>
            {s?.label || '…'}
          </span>
        </span>
      </span>
      <button type="button" onClick={() => send('switch')} title="Trocar a janela ou a tela transmitida (sem parar)">
        <RefreshCw size={15} /> Trocar
      </button>
      <button
        type="button"
        className={muted ? 'off' : ''}
        onClick={() => send('audio')}
        disabled={!s?.hasAudio}
        aria-pressed={!muted}
        title={!s?.hasAudio ? 'Esta transmissão está sem som' : muted ? 'Ligar o som da transmissão' : 'Desligar o som da transmissão'}
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />} {muted ? 'Sem som' : 'Com som'}
      </button>
      <button type="button" className="stop" onClick={() => send('stop')} title="Parar a transmissão">
        <MonitorOff size={15} /> Parar
      </button>
      <button type="button" className="hide" onClick={() => send('hide')} title="Ocultar este dock (a transmissão continua)" aria-label="Ocultar">
        <ChevronDown size={16} />
      </button>
    </div>
  );
}

createRoot(document.getElementById('dock')).render(
  <StrictMode>
    <ShareDock />
  </StrictMode>,
);
