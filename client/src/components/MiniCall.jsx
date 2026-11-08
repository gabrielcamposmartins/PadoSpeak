// Miniatura da chamada fora da tela dela: o foco (o que você estava vendo na chamada, ou alguém
// transmitindo, com a câmera ligada, quem falou por último, o outro da conversa) no canto inferior esquerdo.
// Clicar volta direto para a chamada.
//
// - Computador: dentro da caixa "Voz conectada" (embaixo, à esquerda), sem cobrir os botões dela.
// - Celular (chamada minimizada), tablet e as páginas Hostear/Painel: flutuando no canto.
// - Arrastada para outro lugar (clicar, segurar e arrastar), ela fica flutuando onde foi solta, em qualquer
//   tela, até voltar ao lugar padrão (o botão que aparece ao passar o mouse). A posição fica neste aparelho.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { MonitorUp, Volume2, RotateCcw } from 'lucide-react';
import { useStore } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import { useLayout } from '../lib/layout.js';
import { plain } from '../lib/text.js';
import Avatar from './Avatar.jsx';

const POS_KEY = 'padospeak.miniCallPos';
/** Antes disto, o ponteiro só tremeu: é um clique. */
const DRAG_START = 6;

function readPos() {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null;
  } catch {
    return null;
  }
}
/** Onde a pessoa deixou a miniatura (`{x, y}`: o canto de cima à esquerda, em fração da tela), ou null. */
const usePos = create(() => ({ pos: readPos() }));
function savePos(pos) {
  try {
    if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
    else localStorage.removeItem(POS_KEY);
  } catch {
    /* sem armazenamento: vale até fechar */
  }
  usePos.setState({ pos });
}
/** A miniatura foi arrastada para um lugar próprio? */
export const useMiniCallMoved = () => usePos((st) => Boolean(st.pos));

/** A posição guardada, sem sair da tela (a janela pode ter mudado de tamanho). */
const placeStyle = (pos) => ({
  left: `clamp(8px, ${(pos.x * 100).toFixed(2)}vw, calc(100vw - 184px))`,
  top: `clamp(8px, ${(pos.y * 100).toFixed(2)}vh, calc(100vh - 110px))`,
  right: 'auto',
  bottom: 'auto',
});

/** A tela aberta agora é a da chamada? */
export function useOnCallPage() {
  const vc = useVoiceConn();
  const voice = vc((s) => s.voice);
  const view = useStore((s) => s.view);
  const guildId = useStore((s) => s.currentGuildId);
  if (!voice) return false;
  if (voice.dm) return (view?.type === 'dm' || view?.type === 'call') && view.channelId === voice.channelId;
  return view?.type === 'voice' && view.channelId === voice.channelId && guildId === voice.guildId;
}

function MiniVideo({ stream, mirror }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play?.().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={`mini-video${mirror ? ' mirror' : ''}`} autoPlay muted playsInline />;
}

/** O que mostrar: o foco escolhido na chamada (se ainda existir), senão o mais interessante agora. */
function pickFocus(voice, me, focusId, lastSpeaker) {
  const tiles = [];
  for (const p of voice.peers) {
    if (p.screenStream) tiles.push({ id: `${p.peerId}:screen`, user: p.user, stream: p.screenStream, screen: true });
    tiles.push({ id: p.peerId, user: p.user, stream: p.cameraStream, speaking: voice.speaking[p.peerId] });
  }
  if (voice.localScreen) tiles.push({ id: 'me:screen', user: me, stream: voice.localScreen, screen: true, self: true });
  tiles.push({ id: 'me', user: me, stream: voice.localCamera, self: true, mirror: voice.cameraFacing !== 'environment', speaking: voice.speaking.me });
  const chosen = focusId && tiles.find((t) => t.id === focusId);
  // O meu próprio quadro sem vídeo não diz nada: aí vale o resto.
  if (chosen && (chosen.stream || !chosen.self)) return chosen;
  return (
    tiles.find((t) => t.screen && !t.self && t.stream) ||
    tiles.find((t) => !t.self && t.stream) ||
    tiles.find((t) => !t.self && t.speaking) ||
    tiles.find((t) => t.id === lastSpeaker) ||
    tiles.find((t) => !t.self) ||
    tiles.find((t) => t.self && t.stream) ||
    null
  );
}

export default function MiniCall({ floating = false }) {
  const vc = useVoiceConn();
  const voice = vc((s) => s.voice);
  const me = vc((s) => s.me);
  const dm = vc((s) => (s.voice?.dm ? s.dms.find((d) => d.id === s.voice.channelId) : null));
  const channel = vc((s) => (s.voice && !s.voice.dm ? s.guildData[s.voice.guildId]?.channels.find((c) => c.id === s.voice.channelId) : null));
  const focusId = useStore((s) => s.callFocus);
  const phone = useLayout() === 'phone';
  const lastSpeaker = useRef(null);
  const pos = usePos((st) => st.pos);
  const drag = useRef(null);
  const dragged = useRef(false);
  const [ghost, setGhost] = useState(null);
  if (!voice) return null;
  const speaking = voice.peers.find((p) => voice.speaking[p.peerId]);
  if (speaking) lastSpeaker.current = speaking.peerId;
  const calling = voice.dm && voice.peers.length === 0;
  const tile = calling ? null : pickFocus(voice, me, focusId, lastSpeaker.current);
  const who = calling ? dm?.recipient : tile?.user;
  const where = dm ? plain(dm.recipient.displayName) : voice.dm ? 'Chamada em grupo' : channel ? channel.name : 'Chamada';
  const label = calling ? `Chamando ${where}…` : tile?.screen ? `Tela de ${plain(tile.user?.displayName || '')}` : tile?.self ? 'Você' : plain(who?.displayName || where);
  const open = () => {
    const ui = useStore.getState();
    // Hostear e Painel ficam por cima do app: volta para ele.
    if (ui.phase !== 'app') useStore.setState({ phase: 'app' });
    if (phone) useStore.setState({ callMinimized: false });
    else vc.getState().showVoice();
  };
  const placed = floating && pos;
  const classes = `mini-call${floating ? ' floating' : ''}${placed ? ' placed' : ''}${phone ? ' phone' : ''}${tile?.speaking ? ' speaking' : ''}${tile?.stream ? ' has-video' : ''}`;
  const body = (
    <>
      {tile?.stream ? (
        <MiniVideo stream={tile.stream} mirror={tile.mirror && !tile.screen} />
      ) : (
        <span className="mini-face">
          <Avatar user={who || me} size={floating ? 44 : 52} />
        </span>
      )}
      <span className="mini-label">
        {tile?.screen ? <MonitorUp size={12} /> : voice.dm ? null : <Volume2 size={12} />}
        <span>{label}</span>
      </span>
    </>
  );

  // Arrastar: segura e arrasta (um clique sem arrastar abre a chamada). Enquanto arrasta, uma cópia segue o
  // ponteiro direto no <body>: a caixa "Voz conectada" fica num painel de vidro, e lá dentro "fixo" seria
  // relativo ao painel, não à tela.
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('.mini-reset')) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const spot = (e, d) => ({
    left: Math.min(Math.max(8, e.clientX - d.dx), window.innerWidth - d.w - 8),
    top: Math.min(Math.max(8, e.clientY - d.dy), window.innerHeight - d.h - 8),
  });
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_START) return;
    d.moved = true;
    setGhost({ ...spot(e, d), w: d.w, h: d.h });
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    const at = spot(e, d);
    savePos({ x: at.left / window.innerWidth, y: at.top / window.innerHeight });
    setGhost(null);
    dragged.current = true;
  };
  const onClick = () => {
    // o clique que vem no fim de um arraste não abre a chamada
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    open();
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={`${classes}${ghost ? ' drag-source' : ''}`}
        style={placed ? placeStyle(pos) : undefined}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setGhost(null);
        }}
        title="Voltar para a chamada (arraste para mudar de lugar)"
        aria-label={`Voltar para a chamada: ${label}`}
      >
        {body}
        {placed && (
          <button
            type="button"
            className="mini-reset"
            title="Voltar a miniatura para o lugar padrão"
            aria-label="Voltar a miniatura para o lugar padrão"
            onClick={(e) => {
              e.stopPropagation();
              savePos(null);
            }}
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      {ghost &&
        createPortal(
          <div
            className={`${classes} floating dragging`}
            style={{ left: ghost.left, top: ghost.top, width: ghost.w, height: ghost.h, right: 'auto', bottom: 'auto' }}
            aria-hidden="true"
          >
            {body}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * A miniatura flutuante: no celular quando a chamada está minimizada, no tablet fora da tela da chamada e,
 * no computador, nas páginas que ficam por cima do app (Hostear, Painel) — no resto, ela fica na caixa
 * "Voz conectada" (veja `VoiceStatus`).
 */
export function FloatingMiniCall() {
  const vc = useVoiceConn();
  const inCall = vc((s) => Boolean(s.voice));
  const layout = useLayout();
  const phase = useStore((s) => s.phase);
  const minimized = useStore((s) => s.callMinimized);
  const onPage = useOnCallPage();
  const moved = useMiniCallMoved();
  if (!inCall) return null;
  // arrastada para um lugar próprio, ela flutua fora da tela da chamada também no computador
  const show = layout === 'phone' ? minimized : phase !== 'app' || (!onPage && (layout === 'tablet' || moved));
  return show ? <MiniCall floating /> : null;
}
