import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import WindowFrame from './components/WindowFrame.jsx';
import { isTauri } from './lib/env.js';
import { watchViewport } from './lib/layout.js';
import { initPwa } from './lib/pwa.js';
import { unlockAudio } from './lib/sounds.js';
import { openFromUrl, initBackNavigation } from './store.js';
import './styles.css';

// App desktop: título e botões da janela por cima da cena do topo (a janela não tem a moldura do Windows).
// `?frame` mostra a barra no navegador durante o desenvolvimento.
if (isTauri || (import.meta.env.DEV && new URLSearchParams(location.search).has('frame'))) {
  document.documentElement.classList.add('framed');
  const frame = document.createElement('div');
  frame.id = 'frame';
  document.body.prepend(frame);
  createRoot(frame).render(<WindowFrame />);
}

// Celular e tablet: altura visível (teclado), atributos de layout/toque e o app instalado (PWA).
watchViewport();
initPwa({ onOpen: openFromUrl });
initBackNavigation();
// O iPhone só libera áudio dentro de um toque: o primeiro toque deixa os sons de aviso prontos.
window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
