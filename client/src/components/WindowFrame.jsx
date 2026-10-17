// Barra de título do app desktop: a janela não usa a moldura do Windows, então arrastar, minimizar,
// maximizar/restaurar e fechar ficam aqui, no mesmo visual Aero do resto do app.
import { useEffect, useState } from 'react';
import { isTauri } from '../lib/env.js';
import { MiniLogo, TitleBar } from './Aero.jsx';

let current;
const appWindow = () => (current ??= import('@tauri-apps/api/window').then((m) => m.getCurrentWindow()));
const act = (fn) => () => isTauri && appWindow().then(fn);

function Glyph({ kind }) {
  const paths = {
    min: <rect x="2" y="7" width="8" height="2.2" rx=".6" />,
    max: <path d="M1.5 1.5h9v9h-9z M3.3 4h5.4v4.7H3.3z" fillRule="evenodd" />,
    restore: <path d="M3.5 .8h7.7v7.7H9.6V2.4H3.5z M.8 3.6h7.6v7.6H.8z M2.5 5.8h4.2v3.7H2.5z" fillRule="evenodd" />,
    close: <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" fill="none" />,
  };
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

export default function WindowFrame() {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    const unlisten = [];
    const keep = (off) => (alive ? unlisten.push(off) : off());
    appWindow().then(async (win) => {
      const sync = async () => {
        const max = await win.isMaximized();
        if (alive) setMaximized(max);
      };
      sync();
      keep(await win.onResized(sync));
      keep(await win.onFocusChanged(({ payload }) => alive && setFocused(payload)));
    });
    return () => {
      alive = false;
      unlisten.forEach((off) => off());
    };
  }, []);

  return (
    <header className={`window-frame${focused ? '' : ' inactive'}`} data-tauri-drag-region>
      <MiniLogo size={16} />
      <span className="wf-title">PadoSpeak</span>
      <div className="wf-caption">
        <button type="button" className="wf-btn" title="Minimizar" aria-label="Minimizar" onClick={act((w) => w.minimize())}>
          <Glyph kind="min" />
        </button>
        <button
          type="button"
          className="wf-btn"
          title={maximized ? 'Restaurar' : 'Maximizar'}
          aria-label={maximized ? 'Restaurar' : 'Maximizar'}
          onClick={act((w) => w.toggleMaximize())}
        >
          <Glyph kind={maximized ? 'restore' : 'max'} />
        </button>
        <button
          type="button"
          className="wf-btn close"
          title="Fechar (o PadoSpeak continua na bandeja, perto do relógio)"
          aria-label="Fechar"
          onClick={act((w) => w.close())}
        >
          <Glyph kind="close" />
        </button>
      </div>
    </header>
  );
}

/**
 * Barra de título do cartão (entrada e carregamento). No app do Windows a janela é o próprio cartão, então
 * ela arrasta a janela e tem minimizar e fechar (fechar vai para a bandeja, como na janela grande).
 */
export function CardTitleBar() {
  if (!isTauri) return <TitleBar title="PadoSpeak" />;
  return (
    <div className="titlebar card-frame" data-tauri-drag-region>
      <MiniLogo />
      <span className="tb-title">PadoSpeak</span>
      <div className="tb-caption">
        <button type="button" className="tb-min" title="Minimizar" aria-label="Minimizar" onClick={act((w) => w.minimize())}>
          <Glyph kind="min" />
        </button>
        <button
          type="button"
          className="tb-close"
          title="Fechar (o PadoSpeak continua na bandeja, perto do relógio)"
          aria-label="Fechar"
          onClick={act((w) => w.close())}
        >
          <Glyph kind="close" />
        </button>
      </div>
    </div>
  );
}
