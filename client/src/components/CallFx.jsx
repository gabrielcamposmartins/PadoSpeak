// Efeitos dos gestos na chamada: os emojis subindo no vídeo de quem fez o gesto, o selo de mão levantada e, para
// quem não tem vídeo na tela agora, um canto com o emoji e o nome.
import { useEffect } from 'react';
import { FX_EMOJI, useUserFx, useAllFx, mountTile, hasTile } from '../lib/callfx.js';
import { useStore } from '../store.js';
import { useVoiceConn } from './conn.jsx';
import { plain } from '../lib/text.js';

/** Emojis no vídeo de `userId` (dentro de um elemento com `position: relative`). */
export function TileFx({ userId }) {
  useEffect(() => mountTile(userId), [userId]);
  const fx = useUserFx(userId);
  if (!fx.length) return null;
  return (
    <div className="tile-fx" aria-hidden="true">
      {fx.map((f) => (
        <span key={f.id} className="tile-fx-emoji" style={{ '--fx-x': `${30 + ((f.id * 37) % 40)}%` }}>
          {FX_EMOJI[f.kind]}
        </span>
      ))}
    </div>
  );
}

/** ✋ no vídeo de quem levantou a mão (no próprio, um clique abaixa). */
export function HandBadge({ self, onLower }) {
  if (self)
    return (
      <button
        type="button"
        className="tile-hand"
        title="Você levantou a mão (☝️). Clique para abaixar."
        aria-label="Abaixar a mão"
        onClick={(e) => {
          e.stopPropagation();
          onLower?.();
        }}
      >
        ✋
      </button>
    );
  return (
    <span className="tile-hand" title="Levantou a mão" aria-label="Levantou a mão" role="img">
      ✋
    </span>
  );
}

/** Efeitos de quem não tem vídeo visível agora (na conversa, com a chamada minimizada…). */
export function CallFxCorner() {
  const voiceConn = useVoiceConn();
  const voice = voiceConn((s) => s.voice);
  const me = voiceConn((s) => s.me);
  const all = useAllFx();
  const phase = useStore((s) => s.phase);
  if (!voice || phase !== 'app') return null;
  const shown = all.filter((f) => !hasTile(f.userId));
  if (!shown.length) return null;
  const nameOf = (id) => {
    if (id === me?.id) return 'Você';
    const p = voice.peers.find((x) => x.user?.id === id);
    return plain(p?.user?.displayName) || 'Alguém';
  };
  return (
    <div className="callfx-corner" aria-live="polite">
      {shown.map((f) => (
        <span key={f.id} className="callfx-chip">
          <span className="callfx-emoji" aria-hidden="true">
            {FX_EMOJI[f.kind]}
          </span>
          {nameOf(f.userId)}
        </span>
      ))}
    </div>
  );
}
