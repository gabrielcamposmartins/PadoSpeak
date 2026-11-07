// Miniatura da chamada fora da tela dela: o foco (o que você estava vendo na chamada, ou alguém
// transmitindo, com a câmera ligada, quem falou por último, o outro da conversa) no canto inferior esquerdo.
// Clicar volta direto para a chamada.
//
// - Computador: dentro da caixa "Voz conectada" (embaixo, à esquerda), sem cobrir os botões dela.
// - Celular (chamada minimizada), tablet e as páginas Hostear/Painel: flutuando no canto.
import { useEffect, useRef } from 'react';
import { MonitorUp, Volume2 } from 'lucide-react';
import { useStore } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import { useLayout } from '../lib/layout.js';
import { plain } from '../lib/text.js';
import Avatar from './Avatar.jsx';

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
  return (
    <button
      type="button"
      className={`mini-call${floating ? ' floating' : ''}${phone ? ' phone' : ''}${tile?.speaking ? ' speaking' : ''}${tile?.stream ? ' has-video' : ''}`}
      onClick={open}
      title="Voltar para a chamada"
      aria-label={`Voltar para a chamada: ${label}`}
    >
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
    </button>
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
  if (!inCall) return null;
  const show = layout === 'phone' ? minimized : phase !== 'app' || (layout === 'tablet' && !onPage);
  return show ? <MiniCall floating /> : null;
}
