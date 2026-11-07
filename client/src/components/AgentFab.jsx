/**
 * Módulo Assistente, flutuante: o ícone do assistente no canto inferior direito da tela (escolha em
 * Configurações → Assistente), no lugar do ícone no pé do trilho. Abre e fecha o balão (Agent.jsx), que
 * aparece logo acima dele. Fica fora do balão (que só é baixado quando abre) para estar sempre à vista.
 *
 * O canto pode ter algo clicável embaixo (o Enviar da conversa sem a lista de membros, controles de outras
 * telas): aí o botão sobe até achar um lugar livre, para não cobrir nada.
 */
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useStore } from '../store.js';
import { formatHotkey, hotkeysOf } from '../lib/hotkeys.js';

const SIZE = 52;
const EDGE = 18;
const STEP = 12;
/** O que o botão não pode cobrir. */
const CLICKABLE = 'button, a[href], input, textarea, select, [role="button"], [contenteditable="true"]';

/** Quanto o botão sobe a partir do canto para não ficar em cima de nada clicável. */
function useClearSpot() {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const blocked = (bottom) => {
      const left = window.innerWidth - EDGE - SIZE;
      const top = window.innerHeight - bottom - SIZE;
      // os cantos com uma folga de 6 px em volta, os meios das bordas e o centro
      const [l, t, r, b] = [left - 6, top - 6, left + SIZE + 6, top + SIZE + 6];
      const pts = [
        [l, t],
        [r, t],
        [l, b],
        [r, b],
        [left + SIZE / 2, t],
        [left + SIZE / 2, b],
        [l, top + SIZE / 2],
        [left + SIZE / 2, top + SIZE / 2],
      ];
      return pts.some(([x, y]) => document.elementsFromPoint(x, y).some((el) => !el.closest('.agent-fab, .agent-pop') && el.closest(CLICKABLE)));
    };
    const check = () => {
      for (let b = EDGE; b < window.innerHeight / 2; b += STEP) {
        if (!blocked(b)) return setLift(b - EDGE);
      }
      setLift(0);
    };
    // confere logo que a tela muda (abriu a lista de membros, trocou de canal), no máximo a cada 300 ms, e de
    // tempos em tempos para o que não muda o DOM (rolagem, animações)
    let timer = null;
    const soon = () => {
      if (!timer) timer = setTimeout(() => ((timer = null), check()), 300);
    };
    const watch = new MutationObserver(soon);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    check();
    const t = setInterval(check, 1500);
    window.addEventListener('resize', soon);
    return () => {
      watch.disconnect();
      clearTimeout(timer);
      clearInterval(t);
      window.removeEventListener('resize', soon);
    };
  }, []);
  return lift;
}

export default function AgentFab() {
  const open = useStore((s) => s.agentOpen);
  const hotkey = useStore((s) => hotkeysOf(s.prefs).agent);
  const lift = useClearSpot();
  // o balão aberto acompanha o botão quando ele sobe ou desce
  useEffect(() => {
    window.dispatchEvent(new Event('agent-fab-moved'));
  }, [lift]);
  const hint = hotkey ? ` (${formatHotkey(hotkey)})` : '';
  return (
    <button
      type="button"
      className={`agent-fab${open ? ' on' : ''}`}
      style={{ right: EDGE, bottom: EDGE + lift }}
      title={`Assistente: peça o que precisar sobre o que está na tela${hint}`}
      aria-label="Assistente"
      aria-expanded={open}
      data-agent-toggle=""
      onClick={() => useStore.getState().toggleAgent()}
    >
      <Sparkles size={24} />
    </button>
  );
}
