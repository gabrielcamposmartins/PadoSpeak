import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import WindowFrame from './components/WindowFrame.jsx';
import { isTauri } from './lib/env.js';
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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
