// Menus do botão direito: pessoa (membros do servidor, amigos, conversas) com as ações do perfil;
// servidor e canal com as notificações pessoais ("Receber notificações" e "Apenas quando mencionado").
import { useState } from 'react';
import { MessageSquare, Phone, UserRound, UserPlus, UserCheck, UserMinus, X, Music2, Ban, Settings, Check, Pencil } from 'lucide-react';
import { useStore, DEFAULT_NOTIFY, channelNotifyLevel } from '../store.js';
import { useConn } from './conn.jsx';
import Avatar, { UserName } from './Avatar.jsx';
import { PointMenu, Item } from './VoiceMenus.jsx';
import { plain } from '../lib/text.js';

/** Opção liga/desliga com a caixinha sempre visível (marcada ou não). */
function CheckItem({ checked, disabled, onClick, children, hint }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className="ctx-item ctx-check-item" disabled={disabled} onClick={onClick}>
      <span className={`ctx-box${checked ? ' on' : ''}`} aria-hidden="true">
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <span className="ctx-check-text">
        {children}
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

const Sep = () => <div className="ctx-sep" role="separator" />;

/** Menu de uma pessoa: as mesmas ações do perfil. */
export function UserMenu({ x, y, user, onClose }) {
  const useC = useConn();
  const me = useC((s) => s.me?.id);
  const isServer = useC((s) => s.kind === 'server');
  const friend = useC((s) => s.friends[user.id]?.status);
  const nudgeBlocked = useC((s) => Boolean(s.nudgeSettings?.nudgeBlocks.some((u) => u.id === user.id)));
  const blocked = useC((s) => Boolean(s.nudgeSettings?.blocks?.some((u) => u.id === user.id)));
  const st = useC.getState();
  const { openModal } = useStore.getState();
  const name = plain(user.displayName) || user.username;
  const act = (fn) => async () => {
    onClose();
    try {
      await fn();
    } catch (e) {
      useStore.getState().notify(e.message);
    }
  };
  const profile = () => openModal({ type: 'profile', userId: user.id, conn: st.key });
  if (user.id === me)
    return (
      <PointMenu x={x} y={y} onClose={onClose} label={`Opções de ${name}`}>
        <div className="ctx-head">
          <Avatar user={user} size={22} frame={false} />
          <UserName user={user} />
        </div>
        <Item icon={UserRound} onClick={act(profile)}>
          Ver perfil
        </Item>
        <Item icon={Pencil} onClick={act(() => openModal({ type: 'editProfile' }))}>
          Personalizar perfil
        </Item>
        <Item icon={Music2} onClick={act(() => openModal({ type: 'settings', tab: 'sons' }))}>
          Editar sons
        </Item>
      </PointMenu>
    );
  return (
    <PointMenu x={x} y={y} onClose={onClose} label={`Opções de ${name}`}>
      <div className="ctx-head">
        <Avatar user={user} size={22} frame={false} />
        <UserName user={user} />
      </div>
      <Item icon={UserRound} onClick={act(profile)}>
        Ver perfil
      </Item>
      <Item icon={MessageSquare} onClick={act(() => st.openDm(user.id))}>
        Mensagem
      </Item>
      <Item icon={Phone} onClick={act(() => st.callUser(user.id))}>
        Ligar
      </Item>
      <Sep />
      {isServer && !friend && !blocked && (
        <Item icon={UserPlus} onClick={act(() => st.sendFriendRequest(user.username))}>
          Adicionar amigo
        </Item>
      )}
      {friend === 'incoming' && (
        <Item icon={UserCheck} onClick={act(() => st.acceptFriend(user.id))}>
          Aceitar pedido de amizade
        </Item>
      )}
      {friend === 'outgoing' && (
        <Item icon={X} onClick={act(() => st.removeFriend(user.id))}>
          Cancelar pedido de amizade
        </Item>
      )}
      {friend === 'friend' && (
        <Item
          icon={UserMinus}
          onClick={act(() =>
            openModal({ type: 'confirm', title: `Desfazer amizade com ${name}?`, text: '', action: () => st.removeFriend(user.id) }),
          )}
        >
          Desfazer amizade
        </Item>
      )}
      <Item icon={Music2} onClick={act(() => openModal({ type: 'userSounds', userId: user.id, conn: st.key }))}>
        Ver os sons rápidos
      </Item>
      <CheckItem checked={nudgeBlocked} onClick={act(() => st.setNudgeBlocked(user.id, !nudgeBlocked))}>
        Não aceitar “chamar atenção”
      </CheckItem>
      {isServer && (
        <>
          <Sep />
          <Item
            icon={Ban}
            danger={!blocked}
            onClick={act(() =>
              blocked
                ? st.setBlocked(user.id, false)
                : openModal({
                    type: 'confirm',
                    title: `Bloquear ${name}?`,
                    text: 'A amizade é desfeita e vocês não podem mais mandar pedido de amizade um ao outro. Dá para desbloquear depois em Configurações → Conta.',
                    action: () => st.setBlocked(user.id, true),
                  }),
            )}
          >
            {blocked ? 'Desbloquear' : 'Bloquear'}
          </Item>
        </>
      )}
    </PointMenu>
  );
}

/** Botão direito numa pessoa: abre o menu dela. Devolve `{ onContextMenu, menu }`. */
export function useUserMenu(user) {
  const [at, setAt] = useState(null);
  return {
    onContextMenu: (e) => {
      if (!user?.id) return;
      e.preventDefault();
      e.stopPropagation();
      setAt({ x: e.clientX, y: e.clientY });
    },
    menu: at && <UserMenu x={at.x} y={at.y} user={user} onClose={() => setAt(null)} />,
  };
}

/** Notificações pessoais de um servidor. */
export function GuildMenu({ x, y, guild, onClose }) {
  const saved = useStore((s) => s.guildNotify[guild.id]);
  const n = { ...DEFAULT_NOTIFY, ...saved };
  const st = useStore.getState();
  const on = n.messages !== 'none';
  const save = (messages) => st.setGuildNotify(guild.id, { ...n, messages }).catch((e) => st.notify(e.message));
  return (
    <PointMenu x={x} y={y} onClose={onClose} label={`Opções de ${guild.name}`}>
      <div className="ctx-head">{guild.name}</div>
      <CheckItem checked={on} onClick={() => save(on ? 'none' : 'all')} hint="Mensagens dos canais de texto">
        Receber notificações do servidor
      </CheckItem>
      <CheckItem checked={n.messages === 'mentions'} disabled={!on} onClick={() => save(n.messages === 'mentions' ? 'all' : 'mentions')} hint="@seu_usuario ou @everyone">
        Apenas quando mencionado
      </CheckItem>
      <Sep />
      <Item
        icon={Settings}
        onClick={() => {
          onClose();
          st.openModal({ type: 'guildSettings', guildId: guild.id, tab: 'notificacoes' });
        }}
      >
        Mais opções de notificação…
      </Item>
    </PointMenu>
  );
}

const LEVEL_NAME = { all: 'todas as mensagens', mentions: 'só menções', none: 'nenhuma' };

/** Notificações pessoais de um canal de texto (a escolha do canal vale mais que a do servidor). */
export function ChannelMenu({ x, y, channel, guildId, onClose }) {
  const saved = useStore((s) => s.guildNotify[guildId]);
  const n = { ...DEFAULT_NOTIFY, ...saved };
  const st = useStore.getState();
  const level = channelNotifyLevel(n, channel.id);
  const own = Boolean(n.channels?.[channel.id]);
  const on = level !== 'none';
  const set = (lv) => st.setChannelNotify(guildId, channel.id, lv);
  return (
    <PointMenu x={x} y={y} onClose={onClose} label={`Opções de #${channel.name}`}>
      <div className="ctx-head">#{channel.name}</div>
      <CheckItem checked={on} onClick={() => set(on ? 'none' : 'all')}>
        Receber notificações do canal
      </CheckItem>
      <CheckItem checked={level === 'mentions'} disabled={!on} onClick={() => set(level === 'mentions' ? 'all' : 'mentions')} hint="@seu_usuario ou @everyone">
        Apenas quando mencionado
      </CheckItem>
      <Sep />
      {own ? (
        <Item icon={X} onClick={() => set(null)}>
          Seguir o servidor ({LEVEL_NAME[n.messages]})
        </Item>
      ) : (
        <p className="ctx-note">Seguindo o servidor ({LEVEL_NAME[n.messages]}).</p>
      )}
    </PointMenu>
  );
}
