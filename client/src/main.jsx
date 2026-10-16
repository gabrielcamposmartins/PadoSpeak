import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import WindowFrame from './components/WindowFrame.jsx';
import { isTauri } from './lib/env.js';
import { watchViewport } from './lib/layout.js';
import { initPwa } from './lib/pwa.js';
import { unlockAudio } from './lib/sounds.js';
import { unlockSoundboard, setSoundboardOutput } from './lib/soundboard.js';
import { openFromUrl, initBackNavigation, setMyActivity, useStore } from './store.js';
import { watchActivity, setCustomPrograms } from './lib/activity.js';
import { onNotificationClick } from './lib/background.js';
import { watchSystemBars } from './lib/systemBars.js';
import { initExternalLinks } from './lib/externalLinks.js';
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
// Celular: barras do sistema (horas e navegação) na cor das bordas do app.
watchSystemBars();
// App do Windows: links abrem no navegador padrão.
initExternalLinks();
initBackNavigation();
onNotificationClick(openFromUrl);
// App do Windows: o jogo em foco vai para o status ("Jogando …").
setCustomPrograms(useStore.getState().prefs.customGames);
watchActivity(setMyActivity);
// O iPhone só libera áudio dentro de um toque: o primeiro toque deixa os sons de aviso prontos.
window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
window.addEventListener('pointerdown', unlockSoundboard, { once: true, capture: true });
setSoundboardOutput(useStore.getState().prefs.devices?.output);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
