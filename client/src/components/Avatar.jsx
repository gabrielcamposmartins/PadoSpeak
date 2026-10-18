import { useState } from 'react';
import { FormattedText } from './Emotes.jsx';
import { plain } from '../lib/text.js';
import { useConn } from './conn.jsx';

/** Dados mais recentes de um usuário (nome/foto podem ter mudado depois que a mensagem chegou). */
export function useUser(user) {
  const useC = useConn();
  const fresh = useC((s) => (user ? s.users[user.id] : null));
  return fresh || user;
}

/** Endereço da foto: as relativas são do servidor de onde o usuário veio (`base`). */
export const avatarSrc = (url, base) => (url ? (/^https?:/.test(url) ? url : (base || '') + url) : null);

/** Cor escolhida para o nome / mensagem pessoal (fica mais clara no tema escuro, pela classe `tc`). */
export const colorStyle = (c) => (c ? { '--tc': c } : undefined);
export const colorClass = (c, base = '') => `${base}${c ? `${base ? ' ' : ''}tc` : ''}`;

/** Status escolhido → classe da moldura/orbe e nome em português. */
export const STATUS_INFO = {
  online: { cls: 'on', label: 'Online' },
  away: { cls: 'away', label: 'Ausente' },
  busy: { cls: 'busy', label: 'Ocupado' },
  invisible: { cls: 'off', label: 'Offline' },
};

/** O canal de voz é deste servidor? */
const inGuild = (s, guildId, channelId) => Boolean(s.guildData[guildId]?.channels.some((c) => c.id === channelId));

/**
 * Situação de alguém para a moldura: ao vivo, em voz, ou o status escolhido (online, ausente, ocupado, offline).
 * `guildId` (lista de membros de um servidor): a voz só conta se for num canal desse servidor; a chamada em
 * outro servidor (ou em particular) não aparece ali.
 */
export function usePresence(userId, guildId) {
  const useC = useConn();
  return useC((s) => {
    if (!userId) return 'off';
    for (const [channelId, list] of Object.entries(s.voiceStates)) {
      const p = list.find((x) => x.user.id === userId);
      if (p && (!guildId || inGuild(s, guildId, channelId))) return p.screen ? 'live' : 'voice';
    }
    if (userId === s.me?.id) return s.rtStatus === 'connected' ? STATUS_INFO[s.myStatus]?.cls || 'on' : 'off';
    if (!s.online[userId]) return 'off';
    return STATUS_INFO[s.statuses[userId]]?.cls || 'on';
  });
}

/** "Jogando Counter-Strike 2" (o app do Windows conta o jogo em foco), ou null. */
export const gameText = (activity) => (activity?.name ? `Jogando ${activity.name}` : null);

export function useGame(userId) {
  const useC = useConn();
  return useC((s) => gameText(s.activities?.[userId]));
}

/**
 * Onde a pessoa está na voz ("em Sala de Estar · Servidor"). Canal privado não aparece no status: quem vê
 * pode não ter acesso a ele. Com `here` (a lista de membros de um servidor), só a voz desse servidor, sem
 * o nome dele ("em Sala de Estar"): a chamada em outro servidor ou em particular não aparece ali.
 */
export function voicePlace(s, userId, here) {
  for (const [channelId, list] of Object.entries(s.voiceStates)) {
    if (!list.some((x) => x.user.id === userId)) continue;
    if (here) {
      const ch = s.guildData[here]?.channels.find((c) => c.id === channelId);
      if (ch && !ch.private) return `em ${ch.name}`;
      continue;
    }
    for (const [guildId, g] of Object.entries(s.guildData)) {
      const ch = g.channels.find((c) => c.id === channelId);
      if (!ch) continue;
      const guild = s.guilds.find((x) => x.id === guildId)?.name || '';
      return ch.private ? null : `em ${ch.name} · ${guild}`;
    }
    return s.dms.some((d) => d.id === channelId) ? 'em uma chamada' : 'em um canal de voz';
  }
  return null;
}

/** O que a pessoa está fazendo agora, para a linha abaixo do nome: o jogo e/ou onde está na voz. */
export function useActivity(userId, guildId) {
  const useC = useConn();
  return useC((s) => [gameText(s.activities?.[userId]), voicePlace(s, userId, guildId)].filter(Boolean).join(' · ') || null);
}

/** Fundo da foto sem imagem: a cor da pessoa com brilho, como as fotos de exibição do Messenger. */
const picBackground = (c) => `linear-gradient(135deg, color-mix(in srgb, ${c} 50%, #fff), ${c})`;

/**
 * Foto com moldura de presença (verde online, cinza offline, azul em voz, vermelho ao vivo).
 * `status` força a moldura; `frame={false}` mostra só a foto.
 */
export default function Avatar({ user: given, size = 40, status, frame = true, speaking, onClick, online, base, guildId }) {
  const user = useUser(given);
  const useC = useConn();
  const connBase = useC((s) => s.baseUrl);
  const withToken = useC((s) => s.withToken);
  const auto = usePresence(frame && status == null && online == null ? user?.id : null, guildId);
  const [broken, setBroken] = useState(null);
  const name = plain(user?.displayName) || user?.username || '?';
  // Foto deste servidor: vai com o login (quem esconde o perfil de alguém só mostra a foto a quem pode ver).
  const own = user?.avatarUrl && !/^https?:/.test(user.avatarUrl) && (!base || base === connBase);
  const src = own && withToken ? withToken(avatarSrc(user.avatarUrl, connBase)) : avatarSrc(user?.avatarUrl, base || connBase);
  const showImg = src && broken !== src;
  const radius = Math.max(3, Math.round(size * 0.09));
  const pad = size >= 48 ? 3 : 2;
  const st = status ?? (online != null ? (online ? 'on' : 'off') : auto);

  const pic = (
    <span
      className="pic"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.42),
        background: picBackground(user?.avatarColor || '#3a8ee0'),
      }}
    >
      {showImg ? (
        <img src={src} alt="" onError={() => setBroken(src)} draggable={false} />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );

  const interactive = onClick
    ? {
        onClick,
        role: 'button',
        tabIndex: 0,
        onKeyDown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick(e)),
      }
    : {};

  return (
    <span
      className={`avatar${frame ? ` frame ${st}` : ''}${speaking ? ' talk' : ''}${onClick ? ' clickable' : ''}`}
      style={frame ? { padding: pad, borderRadius: radius + pad } : undefined}
      title={name}
      {...interactive}
    >
      {pic}
    </span>
  );
}

/** Nome de exibição sempre atualizado. */
export function UserName({ user, className, style, onClick }) {
  const u = useUser(user);
  return (
    <span
      className={colorClass(u?.nameColor, className || '')}
      style={{ ...style, ...colorStyle(u?.nameColor) }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      <FormattedText text={u?.displayName || u?.username} />
    </span>
  );
}

/** Bolinha de status (versão compacta da moldura). */
export function Orb({ status = 'on', size }) {
  return <span className={`orb ${status}`} style={size ? { width: size, height: size } : undefined} />;
}
