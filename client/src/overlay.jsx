// Sobreposição nos jogos (app do Windows): janela transparente por cima do jogo, que não recebe cliques.
// Mostra a música tocando no canto de cima e as fotos de quem está na chamada em coluna, à esquerda, com o
// nome ao lado de cada foto.
// Conversa com a janela principal por eventos (veja lib/gameOverlay.js e desktop/src-tauri/src/overlay.rs).
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Music2, Pause, MicOff, HeadphoneOff } from 'lucide-react';
import './overlay.css';

/** Até quantas fotos na coluna (o resto vira "+N"), menos se a tela for baixa: cada foto ocupa 29 px. */
const MAX_PEOPLE = 20;
const fitPeople = () => Math.max(2, Math.min(MAX_PEOPLE, Math.floor((window.innerHeight - 80) / 29)));

function useFit() {
  const [fit, setFit] = useState(fitPeople);
  useEffect(() => {
    const on = () => setFit(fitPeople());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return fit;
}

function Person({ p }) {
  const [broken, setBroken] = useState(false);
  return (
    <li className={`ov-person${p.speaking ? ' talk' : ''}`}>
      <span className="ov-face">
        <span className="ov-pic" style={{ '--c': p.color || '#3a8ee0' }}>
          {p.src && !broken ? <img src={p.src} alt="" onError={() => setBroken(true)} /> : (p.name || '?').slice(0, 1).toUpperCase()}
        </span>
        {(p.deafened || p.muted) && (
          <span className="ov-mute" aria-label={p.deafened ? 'ensurdecido' : 'silenciado'}>
            {p.deafened ? <HeadphoneOff size={7} strokeWidth={3} /> : <MicOff size={7} strokeWidth={3} />}
          </span>
        )}
      </span>
      <span className="ov-name">{p.name}</span>
    </li>
  );
}

export function GameOverlay({ state }) {
  const fit = useFit();
  if (!state) return null;
  const people = state.people || [];
  const extra = people.length - fit;
  return (
    <div className="ov">
      {state.music && (
        <div className={`ov-music${state.music.paused ? ' paused' : ''}`}>
          {state.music.paused ? <Pause size={14} /> : <Music2 size={14} />}
          <span className="ov-track">
            <b>{state.music.title}</b>
            {state.music.artist && <span> · {state.music.artist}</span>}
          </span>
        </div>
      )}
      <ul className="ov-people">
        {people.slice(0, extra > 0 ? fit - 1 : fit).map((p) => (
          <Person key={p.id} p={p} />
        ))}
        {extra > 0 && <li className="ov-more">+{extra + 1}</li>}
      </ul>
    </div>
  );
}

function App() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let off;
    import('@tauri-apps/api/event').then(async ({ listen, emitTo }) => {
      off = await listen('overlay-state', (e) => setState(e.payload));
      emitTo('main', 'overlay-ready', null).catch(() => {});
    });
    return () => off?.();
  }, []);
  return <GameOverlay state={state} />;
}

const root = document.getElementById('overlay');
// Prévia/testes: o estado pode vir pronto em window.__overlayState (sem o app do Windows).
createRoot(root).render(<StrictMode>{window.__overlayState ? <GameOverlay state={window.__overlayState} /> : <App />}</StrictMode>);
