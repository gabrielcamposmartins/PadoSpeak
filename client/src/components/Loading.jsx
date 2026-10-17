// Tela de carregamento: o ícone do PadoSpeak grande, só o gorro branco girando (encolhe no meio da volta,
// com blur de movimento), e embaixo o que está carregando.
import { useId } from 'react';
import { SceneArt } from './Aero.jsx';
import { CardTitleBar } from './WindowFrame.jsx';

const HAT = 'M14 43C14 26 24 13.5 36 13.5C45.5 13.5 51.5 21 53.2 33L48.4 33.6C47.4 28.2 45 25 41.2 24.4C44.8 29.4 47.3 35.8 49.2 43Z';

/** Silhueta do gorro, sem os contornos: as cópias atrasadas do blur de movimento. */
function Ghost({ className, blur }) {
  return (
    <g className={`boot-ghost ${className}`} filter={`url(#${blur})`}>
      <path d={HAT} />
      <circle cx="51" cy="36.4" r="5.8" />
      <rect x="10" y="40.5" width="44" height="11.5" rx="5.75" />
    </g>
  );
}

export function SpinningLogo() {
  const blur = `boot-blur${useId().replace(/:/g, '')}`;
  return (
    <svg className="boot-logo" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <filter id={blur} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
      </defs>
      <rect width="64" height="64" rx="16" fill="#D93F3A" />
      <Ghost className="g3" blur={blur} />
      <Ghost className="g2" blur={blur} />
      <Ghost className="g1" blur={blur} />
      <g className="boot-hat">
        <path d={HAT} fill="#fff" />
        <circle cx="51" cy="36.4" r="5.8" fill="#fff" stroke="#D93F3A" strokeWidth="2.6" />
        <rect x="10" y="40.5" width="44" height="11.5" rx="5.75" fill="#fff" stroke="#D93F3A" strokeWidth="2.6" />
      </g>
    </svg>
  );
}

/** O conteúdo (ícone, texto e, ao baixar, a barra). `over`: por cima do formulário, que continua montado. */
export function LoadingBody({ text, sub, progress, over }) {
  return (
    <div className={`boot-body${over ? ' over' : ''}`}>
      <SpinningLogo />
      <p className="boot-text" role="status" aria-live="polite">
        {text}
        {sub && <small>{sub}</small>}
      </p>
      {progress != null && (
        <div className="np-progress boot-progress" aria-hidden="true">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Tela inteira de carregamento: no app do Windows é a janela pequena; no navegador, o cartão no meio. */
export default function BootScreen(props) {
  return (
    <div className="auth-page scene">
      <SceneArt wide />
      <div className="auth-card window boot-card">
        <CardTitleBar />
        <LoadingBody {...props} />
      </div>
    </div>
  );
}
