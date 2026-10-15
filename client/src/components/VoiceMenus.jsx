// Pessoas nos canais de voz: perfil rápido (clique), menu de contexto (botão direito) com silenciar
// para mim / para todos, mover de canal e desconectar, e arrastar alguém para outro canal de voz.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, UserRound, VolumeX, MicOff, ArrowRightLeft, PhoneOff, Volume2, Check } from 'lucide-react';
import { useStore, usePerms } from '../store.js';
import Avatar, { UserName, usePresence, STATUS_INFO } from './Avatar.jsx';
import { FormattedText, Floating } from './Emotes.jsx';
import { plain } from '../lib/text.js';

/** Tipo usado no arrastar e soltar de pessoas entre canais de voz. */
export const DRAG_PEER = 'application/x-padospeak-peer';

/** Janelinha presa a um ponto da tela (o lugar do clique), sem sair da janela. */
function PointMenu({ x, y, onClose, label, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPos({ left: Math.max(6, Math.min(x, window.innerWidth - box.width - 6)), top: Math.max(6, Math.min(y, window.innerHeight - box.height - 6)) });
  }, [x, y]);
  useEffect(() => {
    const down = (e) => !ref.current?.contains(e.target) && onClose();
    const key = (e) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="popover ctx-menu" role="menu" aria-label={label} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

function Item({ icon: Icon, children, onClick, danger, checked, disabled }) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={`ctx-item${danger ? ' danger' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={15} />
      <span>{children}</span>
      {checked && <Check size={14} className="ctx-check" />}
    </button>
  );
}

/**
 * Menu de uma pessoa num canal de voz. `p`: participante (peerId, user, serverMuted), `channelId` e
 * `guildId` (null numa chamada direta).
 */
export function VoiceMemberMenu({ x, y, p, channelId, guildId, onClose }) {
  const perms = usePerms(useStore, guildId);
  const me = useStore((s) => s.me?.id);
  const localMuted = useStore((s) => Boolean(s.prefs.localMutes?.[p.user.id]));
  const channels = useStore((s) => s.guildData[guildId]?.channels) || [];
  const [moving, setMoving] = useState(false);
  const st = useStore.getState();
  const self = p.user.id === me;
  const name = plain(p.user.displayName) || p.user.username;
  const act = (fn) => () => {
    onClose();
    fn();
  };
  const others = channels.filter((c) => c.type === 'voice' && c.id !== channelId);
  return (
    <PointMenu x={x} y={y} onClose={onClose} label={`Opções de ${name}`}>
      <div className="ctx-head">
        <Avatar user={p.user} size={22} frame={false} />
        <UserName user={p.user} />
      </div>
      <Item icon={UserRound} onClick={act(() => st.openModal({ type: 'profile', userId: p.user.id }))}>
        Ver perfil
      </Item>
      {!self && (
        <Item icon={VolumeX} checked={localMuted} onClick={act(() => st.toggleLocalMute(p.user.id))}>
          Silenciar para mim
        </Item>
      )}
      {guildId && perms.mute && (
        <Item icon={MicOff} checked={Boolean(p.serverMuted)} onClick={act(() => st.moderateVoice(p.peerId, p.serverMuted ? 'unmute' : 'mute'))}>
          Silenciar para todos
        </Item>
      )}
      {guildId && perms.move && others.length > 0 && (
        <>
          <Item icon={ArrowRightLeft} onClick={() => setMoving(!moving)}>
            Mover para…
          </Item>
          {moving && (
            <div className="ctx-sub" role="group" aria-label="Canais de voz">
              {others.map((c) => (
                <button key={c.id} type="button" role="menuitem" className="ctx-item sub" onClick={act(() => st.moderateVoice(p.peerId, 'move', c.id))}>
                  <Volume2 size={14} />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {guildId && perms.disconnect && (
        <Item icon={PhoneOff} danger onClick={act(() => st.moderateVoice(p.peerId, 'disconnect'))}>
          Desconectar
        </Item>
      )}
    </PointMenu>
  );
}

/** Perfil rápido (como um balão): fica aberto até clicar em outra coisa. */
export function QuickProfile({ anchorRef, user, onClose }) {
  const status = usePresence(user.id);
  const fresh = useStore((s) => s.users[user.id]) || user;
  const me = useStore((s) => s.me?.id);
  const st = useStore.getState();
  const info = STATUS_INFO[{ on: 'online', away: 'away', busy: 'busy' }[status]];
  return (
    <Floating anchorRef={anchorRef} onClose={onClose} place="right" className="quick-profile" role="dialog" aria-label={`Perfil de ${plain(fresh.displayName)}`}>
      <div className="qp-banner" style={{ background: fresh.bannerColor || fresh.avatarColor }} />
      <div className="qp-body">
        <Avatar user={fresh} size={56} />
        <b className="qp-name">
          <UserName user={fresh} />
        </b>
        <span className="qp-user">
          @{fresh.username}
          {info && ` · ${info.label}`}
        </span>
        {fresh.bio && (
          <span className="qp-bio">
            <FormattedText text={fresh.bio} size={14} />
          </span>
        )}
        <div className="qp-actions">
          {user.id !== me && (
            <button
              type="button"
              className="gloss mini"
              title="Mensagem"
              aria-label={`Mensagem para ${plain(fresh.displayName)}`}
              onClick={() => {
                onClose();
                st.openDm(user.id);
              }}
            >
              <MessageSquare size={15} />
            </button>
          )}
          <button
            type="button"
            className="gloss mini"
            title="Perfil completo"
            aria-label="Perfil completo"
            onClick={() => {
              onClose();
              st.openModal({ type: 'profile', userId: user.id });
            }}
          >
            <UserRound size={15} />
          </button>
        </div>
      </div>
    </Floating>
  );
}

/**
 * Comportamento de uma pessoa na lista do canal de voz: clique abre o perfil rápido, botão direito
 * abre o menu e (com permissão) dá para arrastar para outro canal. Devolve as props da linha e o que
 * desenhar (balão/menu).
 */
export function useVoicePerson({ p, channelId, guildId, onClick }) {
  const ref = useRef(null);
  const [quick, setQuick] = useState(false);
  const [menu, setMenu] = useState(null);
  const canMove = usePerms(useStore, guildId).move && Boolean(guildId);
  const props = {
    ref,
    onClick: (e) => {
      e.stopPropagation();
      if (onClick) return onClick(e);
      setQuick((v) => !v);
    },
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setQuick(false);
      setMenu({ x: e.clientX, y: e.clientY });
    },
    draggable: canMove || undefined,
    onDragStart: canMove
      ? (e) => {
          setQuick(false);
          e.dataTransfer.setData(DRAG_PEER, JSON.stringify({ peerId: p.peerId, from: channelId }));
          e.dataTransfer.effectAllowed = 'move';
        }
      : undefined,
  };
  const overlay = (
    <>
      {quick && <QuickProfile anchorRef={ref} user={p.user} onClose={() => setQuick(false)} />}
      {menu && <VoiceMemberMenu x={menu.x} y={menu.y} p={p} channelId={channelId} guildId={guildId} onClose={() => setMenu(null)} />}
    </>
  );
  return { props, overlay, openQuick: () => setQuick(true) };
}

/** Canal de voz que recebe alguém arrastado (mover de canal). */
export function voiceDropProps(channelId, setOver) {
  return {
    onDragOver: (e) => {
      if (![...e.dataTransfer.types].includes(DRAG_PEER)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false);
      const raw = e.dataTransfer.getData(DRAG_PEER);
      if (!raw) return;
      e.preventDefault();
      const { peerId, from } = JSON.parse(raw);
      if (from !== channelId) useStore.getState().moderateVoice(peerId, 'move', channelId);
    },
  };
}
