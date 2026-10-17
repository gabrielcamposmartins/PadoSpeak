import {
  Plus,
  Hash,
  Volume2,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Settings,
  PhoneOff,
  Video,
  MonitorUp,
  Server,
  UserPlus,
  Trash2,
  Pencil,
  Lock,
  Crown,
  Shield,
  Users,
  Music,
  ChevronDown,
  AudioWaveform,
  Activity,
  Link2,
  Menu,
  X,
  VolumeX,
  ChartColumn,
  Download,
  Gamepad2,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import { useStore, primaryConn, setStatusEverywhere, connRegistry, usePerms, openMyProfile } from '../store.js';
import { isDesktop, DOWNLOAD_URL } from '../lib/env.js';
import { offerWindowsApp } from './AuthPage.jsx';
import { ConnProvider, useAcross, useVoiceConn } from './conn.jsx';
import { canHost } from '../lib/host.js';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLayout, useNarrow, isTouch } from '../lib/layout.js';
import MobileShell, { MobileBack } from './Mobile.jsx';
import Avatar, { UserName, Orb, useActivity, useGame, gameText, STATUS_INFO, colorClass, colorStyle } from './Avatar.jsx';
import { useUserMenu, GuildMenu, ChannelMenu } from './ContextMenus.jsx';
import { SceneArt, BuddiesIcon } from './Aero.jsx';
import { HomeSidebar, FriendsPage, DmView } from './Home.jsx';
import ChatView from './ChatView.jsx';
import VoiceView from './VoiceView.jsx';
import { useServerPing } from './hooks.js';
import MusicPanel from './MusicPanel.jsx';
import SoundPanel from './SoundPanel.jsx';
import { FormattedText, Floating } from './Emotes.jsx';
import { plain } from '../lib/text.js';
import { useVoicePerson, voiceDropProps } from './VoiceMenus.jsx';
import { GroupHeader, useCollapsed } from './Group.jsx';

const NO_PERMS = {};
const openProfile = (userId) => useStore.getState().openModal({ type: 'profile', userId });

const initials = (name) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

// ---------- Faixa do topo: você, estilo Messenger ----------

const STATUS_ORDER = [
  ['online', 'Disponível para todo mundo'],
  ['away', 'Fora do computador por um tempo'],
  ['busy', 'Não quero ser incomodado'],
  ['invisible', 'Aparecer offline (você continua vendo tudo)'],
];

/** Botão "Online ▾" com o menu para escolher o próprio status. */
export function StatusMenu({ status, label }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const myStatus = useAcross(() => primaryConn().getState().myStatus);
  return (
    <span className="status-wrap">
      <button
        ref={btn}
        className="status-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Mudar status"
        onClick={() => setOpen((v) => !v)}
      >
        <Orb status={status} />
        <span className="pb-where">{label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <Floating
          anchorRef={btn}
          place="below"
          onClose={() => setOpen(false)}
          className="status-menu"
          role="menu"
          aria-label="Status"
        >
          {STATUS_ORDER.map(([key, hint]) => (
            <button
              key={key}
              role="menuitemradio"
              aria-checked={myStatus === key}
              className={`status-item${myStatus === key ? ' sel' : ''}`}
              onClick={() => {
                setOpen(false);
                if (key !== myStatus) setStatusEverywhere(key);
              }}
            >
              <Orb status={STATUS_INFO[key].cls} />
              <span>
                <b>{STATUS_INFO[key].label}</b>
                <small>{hint}</small>
              </span>
            </button>
          ))}
        </Floating>
      )}
    </span>
  );
}

export function ProfileBar({ onMenu }) {
  const prim = primaryConn();
  const me = prim((s) => s.me);
  const base = prim((s) => s.baseUrl);
  const rtStatus = prim((s) => s.rtStatus);
  const myStatus = prim((s) => s.myStatus);
  const vc = useVoiceConn();
  const voice = vc((s) => s.voice);
  const muted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.selfDeafened);
  const nsOn = useStore((s) => s.prefs.noiseSuppression !== false);
  const channel = vc((s) =>
    s.voice && !s.voice.dm ? s.guildData[s.voice.guildId]?.channels.find((c) => c.id === s.voice.channelId) : null,
  );
  const dm = vc((s) => (s.voice?.dm ? s.dms.find((d) => d.id === s.voice.channelId) : null));
  const playing = vc((s) => (s.voice ? s.music[s.voice.channelId]?.current?.track : null));
  const game = prim((s) => gameText(s.activities?.[s.me?.id]));
  if (!me) return null;
  const { toggleMute, toggleDeafen, openModal, setNoiseSuppression } = useStore.getState();

  const offline = rtStatus !== 'connected';
  const chosen = STATUS_INFO[myStatus] || STATUS_INFO.online;
  // A moldura mostra voz/ao vivo; a bolinha do menu mostra sempre o status escolhido.
  const frame = offline ? 'off' : voice?.screen ? 'live' : voice ? 'voice' : chosen.cls;
  const orb = offline ? 'off' : chosen.cls;
  const statusLabel = myStatus === 'invisible' ? 'Offline (invisível)' : chosen.label;
  const where = offline
    ? isDesktop
      ? 'Reconectando ao perfil local…'
      : 'Reconectando ao servidor…'
    : dm
      ? `${statusLabel} · em chamada com ${plain(dm.recipient.displayName)}`
      : channel && !channel.private
        ? `${voice.screen ? `${statusLabel} · ao vivo` : statusLabel} · em ${channel.name}`
        : game
          ? `${statusLabel} · ${game}`
          : statusLabel;

  return (
    <header className="profile-bar scene">
      <SceneArt />
      {onMenu && (
        <button className="gloss round pb-menu" onClick={onMenu} title="Conversas e servidores" aria-label="Conversas e servidores">
          <Menu size={20} />
        </button>
      )}
      <Avatar user={me} base={base} size={62} status={frame} speaking={voice?.speaking.me} onClick={openMyProfile} />
      <div className="pb-text">
        <div className="pb-name">
          <button className="pb-me" onClick={() => openModal({ type: 'editProfile' })} title="Editar perfil">
            <span className={colorClass(me.nameColor)} style={colorStyle(me.nameColor)}>
              <FormattedText text={me.displayName} size={20} />
            </span>
          </button>
          <StatusMenu status={orb} label={where} />
        </div>
        <button className="pb-bio" onClick={() => openModal({ type: 'editProfile' })} title="Editar mensagem pessoal">
          {me.bio ? (
            <span className={colorClass(me.bioColor)} style={colorStyle(me.bioColor)}>
              <FormattedText text={me.bio} />
            </span>
          ) : (
            'Escreva uma mensagem pessoal'
          )}
        </button>
        {playing && (
          <div className="pb-music">
            <Music size={14} />
            <span>
              Tocando{channel ? ` em ${channel.name}` : ''}: <b>{playing.title}</b>
              {playing.artist ? ` — ${playing.artist}` : ''}
            </span>
          </div>
        )}
      </div>
      <div className="pb-controls glass">
        <button
          className={`gloss round${muted || deafened ? ' off' : ''}`}
          onClick={toggleMute}
          title={muted ? 'Ativar microfone' : 'Silenciar microfone'}
          aria-label={muted ? 'Ativar microfone' : 'Silenciar microfone'}
          aria-pressed={muted}
        >
          {muted || deafened ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button
          className={`gloss round${deafened ? ' off' : ''}`}
          onClick={toggleDeafen}
          title={deafened ? 'Ativar áudio' : 'Ensurdecer'}
          aria-label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
          aria-pressed={deafened}
        >
          {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </button>
        <button
          className={`${nsOn ? 'go' : 'gloss'} pill`}
          aria-pressed={nsOn}
          onClick={() => setNoiseSuppression(!nsOn)}
          title={nsOn ? 'Supressão de ruído por IA: ligada' : 'Supressão de ruído por IA: desligada'}
        >
          <AudioWaveform size={18} />
          Ruído IA
        </button>
        <button
          className="gloss round"
          onClick={() => openModal({ type: 'settings' })}
          title="Configurações"
          aria-label="Configurações"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}

// ---------- Trilho de servidores ----------

/**
 * Cartão ao passar o mouse num servidor: o nome e quem está em cada canal de voz dele. Os canais de
 * outros servidores carregam na hora (para mostrar o nome do canal).
 */
function GuildTip({ guild, anchor }) {
  const voiceStates = useStore((s) => s.voiceStates);
  const channels = useStore((s) => s.guildData[guild.id]?.channels);
  const base = useStore((s) => s.baseUrl);
  useEffect(() => {
    if (!channels) useStore.getState().loadGuild(guild.id).catch(() => {});
  }, [channels, guild.id]);
  const rooms = Object.entries(voiceStates)
    .filter(([, list]) => list?.length && list[0].guildId === guild.id)
    .map(([channelId, list]) => ({ channelId, list, name: channels?.find((c) => c.id === channelId)?.name }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const r = anchor.getBoundingClientRect();
  const top = Math.max(8, Math.min(r.top + r.height / 2, window.innerHeight - 8));
  return createPortal(
    <div className="guild-tip" role="tooltip" style={{ left: r.right + 12, top }}>
      <b className="guild-tip-name">{guild.name}</b>
      {rooms.map(({ channelId, list, name }) => (
        <div key={channelId} className="guild-tip-room">
          <span className="guild-tip-ch">
            <Volume2 size={13} /> {name || 'Canal de voz'}
          </span>
          {list.map((p) => (
            <span key={p.peerId} className="guild-tip-person">
              <Avatar user={p.user} base={base} size={20} />
              <span className="guild-tip-who">{p.user.displayName ? <FormattedText text={p.user.displayName} size={14} /> : p.user.username}</span>
              {p.screen && <span className="live">AO VIVO</span>}
              {(p.muted || p.serverMuted) && <MicOff size={12} className="guild-tip-ico" aria-label="microfone desligado" />}
              {p.deafened && <HeadphoneOff size={12} className="guild-tip-ico" aria-label="som desligado" />}
            </span>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function GuildRail() {
  const adminAccess = useStore((s) => Boolean(s.appAdmin?.canView));
  const guilds = useStore((s) => s.guilds);
  const current = useStore((s) => s.currentGuildId);
  const { selectGuild, openModal, goHost, homeButton } = useStore.getState();
  const unread = useAcross((states) =>
    states.reduce((n, st) => n + Object.values(st.unread).reduce((a, b) => a + b, 0), 0),
  );
  const pending = useStore((s) => Object.values(s.friends).filter((f) => f.status === 'incoming').length);
  const base = useStore((s) => s.baseUrl);
  const badge = unread + pending;
  // Quantas pessoas estão na voz em cada servidor (um pontinho verde no ícone) e o cartão ao passar o mouse.
  const inVoice = useStore((s) => {
    const n = {};
    for (const list of Object.values(s.voiceStates)) if (list?.[0]?.guildId) n[list[0].guildId] = (n[list[0].guildId] || 0) + list.length;
    return JSON.stringify(n);
  });
  const voiceCount = JSON.parse(inVoice);
  // Avisos não vistos de cada servidor (mensagens que avisaram, menções, entradas na voz…).
  const alertsJson = useStore((s) => {
    const n = {};
    for (const a of Object.values(s.alerts)) if (a?.n) n[a.g] = (n[a.g] || 0) + a.n;
    return JSON.stringify(n);
  });
  const guildAlerts = JSON.parse(alertsJson);
  const [tip, setTip] = useState(null); // { guild, anchor }
  const [menu, setMenu] = useState(null); // { guild, x, y }: notificações do servidor (botão direito)
  return (
    <nav className="guild-rail glass" aria-label="Servidores">
      <div className={`gel-slot${current == null ? ' active' : ''}`}>
        <button
          className="gel home guild-icon"
          title="Início — amigos e conversas"
          aria-label="Início: amigos e conversas"
          onClick={homeButton}
        >
          <BuddiesIcon />
        </button>
        {badge > 0 && <span className="badge guild-badge">{badge > 99 ? '99+' : badge}</span>}
      </div>
      <div className="rail-sep" />
      {guilds.map((g) => (
        <div key={g.id} className={`gel-slot${g.id === current ? ' active' : ''}`}>
          <button
            className={`gel guild guild-icon${g.iconUrl ? ' has-img' : ''}`}
            style={{ '--c': g.iconColor }}
            aria-label={[g.name, voiceCount[g.id] && `${voiceCount[g.id]} na voz`, guildAlerts[g.id] && `${guildAlerts[g.id]} ${guildAlerts[g.id] === 1 ? 'aviso' : 'avisos'}`].filter(Boolean).join(' · ')}
            onClick={() => {
              setTip(null);
              selectGuild(g.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setTip(null);
              setMenu({ guild: g, x: e.clientX, y: e.clientY });
            }}
            onMouseEnter={(e) => !isTouch && setTip({ guild: g, anchor: e.currentTarget })}
            onMouseLeave={() => setTip(null)}
            onFocus={(e) => !isTouch && setTip({ guild: g, anchor: e.currentTarget })}
            onBlur={() => setTip(null)}
          >
            {g.iconUrl ? <img src={base + g.iconUrl} alt="" /> : <span>{initials(g.name)}</span>}
          </button>
          {guildAlerts[g.id] > 0 && g.id !== current && (
            <span className="badge guild-badge" aria-hidden="true">
              {guildAlerts[g.id] > 99 ? '99+' : guildAlerts[g.id]}
            </span>
          )}
          {voiceCount[g.id] > 0 && (
            <span className="guild-voice-dot" aria-hidden="true">
              <Volume2 size={10} strokeWidth={2.6} />
              {voiceCount[g.id]}
            </span>
          )}
        </div>
      ))}
      {tip && <GuildTip guild={guilds.find((g) => g.id === tip.guild.id) || tip.guild} anchor={tip.anchor} />}
      {menu && <GuildMenu x={menu.x} y={menu.y} guild={menu.guild} onClose={() => setMenu(null)} />}
      <button
        className="gel add"
        title="Criar ou entrar em um servidor"
        aria-label="Criar ou entrar em um servidor"
        onClick={() => openModal({ type: 'guild' })}
      >
        <Plus size={22} strokeWidth={2.6} />
      </button>
      <span className="rail-fill" />
      {adminAccess && (
        <button className="gel admin" title="Painel do administrador" aria-label="Painel do administrador" onClick={() => useStore.getState().goAdmin()}>
          <ChartColumn size={20} />
        </button>
      )}
      {(canHost || isDesktop) && (
        <button className="gel host" title="Hostear servidor" aria-label="Hostear servidor" onClick={goHost}>
          <Server size={20} />
        </button>
      )}
    </nav>
  );
}

// ---------- Canais ----------

function VoiceChannelMembers({ channelId, guildId }) {
  const participants = useStore((s) => s.voiceStates[channelId]) || [];
  const voice = useStore((s) => s.voice);
  const playing = useStore((s) => s.music[channelId]?.current?.track);
  if (!participants.length && !playing) return null;
  const inThisCall = voice?.channelId === channelId;
  return (
    <div className="voice-members">
      {playing && (
        <div className="voice-music" title={playing.title}>
          <Music size={13} />
          <span>{playing.title}</span>
        </div>
      )}
      {participants.map((p) => (
        <VoiceMemberRow
          key={p.peerId}
          p={p}
          channelId={channelId}
          guildId={guildId}
          speaking={inThisCall && (p.peerId === voice.selfId ? voice.speaking.me : voice.speaking[p.peerId])}
          watch={p.screen && p.peerId !== voice?.selfId}
          trouble={inThisCall && voice.peers.some((x) => x.peerId === p.peerId && x.trouble)}
        />
      ))}
    </div>
  );
}

/**
 * Pessoa no canal de voz: clique abre o perfil rápido (em quem está ao vivo, abre a transmissão),
 * botão direito abre o menu e, com permissão, dá para arrastar para outro canal.
 */
function VoiceMemberRow({ p, channelId, guildId, speaking, watch, trouble }) {
  const localMuted = useStore((s) => Boolean(s.prefs.localMutes?.[p.user.id]));
  const { props, overlay } = useVoicePerson({
    p,
    channelId,
    guildId,
    onClick: watch ? () => useStore.getState().watchStream(channelId, p.user.id) : undefined,
  });
  return (
    <div
      {...props}
      className={`voice-member${watch ? ' watchable' : ''}`}
      role="button"
      tabIndex={0}
      title={watch ? `Assistir a transmissão de ${plain(p.user.displayName)}` : undefined}
      onKeyDown={(e) => e.key === 'Enter' && props.onClick(e)}
    >
      <Avatar user={p.user} size={20} status={p.screen ? 'live' : 'voice'} speaking={speaking} />
      <UserName user={p.user} className="nm" />
      {p.screen && <span className="live">AO VIVO</span>}
      {p.video && <Video size={14} />}
      {p.serverMuted && <MicOff size={14} className="muted-ico server" aria-label="silenciado para todos" />}
      {localMuted && <VolumeX size={14} className="muted-ico" aria-label="silenciado para você" />}
      {trouble && (
        <span className="muted-ico server" title="Sem conexão de voz com você: reconectando…">
          <WifiOff size={14} aria-label="sem conexão de voz com você" />
        </span>
      )}
      {p.deafened ? (
        <HeadphoneOff size={14} className="muted-ico" aria-label="ensurdecido" />
      ) : p.muted && !p.serverMuted ? (
        <MicOff size={14} className="muted-ico" aria-label="mutado" />
      ) : null}
      {overlay}
    </div>
  );
}

/** Canal de voz na lista: entra ao clicar e recebe quem for arrastado para ele (mover). */
/** Tipo do arrastar de canais (para não se confundir com arrastar pessoas entre canais de voz). */
const DRAG_CHANNEL = 'application/x-padospeak-channel';

function VoiceChannelRow({ c, active, children }) {
  const [over, setOver] = useState(false);
  return (
    <div className={`voice-drop${over ? ' over' : ''}`} {...voiceDropProps(c.id, setOver)}>
      {children}
    </div>
  );
}

function ChannelGroup({ title, type, list, canManage, guildId, activeId }) {
  const { selectTextChannel, joinVoice, openModal, deleteChannel } = useStore.getState();
  const alerts = useStore((s) => s.alerts);
  const [menu, setMenu] = useState(null); // { channel, x, y }: notificações do canal (botão direito)
  const inVoice = useStore((s) => s.voice?.channelId);
  const [collapsed, toggle] = useCollapsed(`${type}:${guildId}`);
  // Recolhida: continua aparecendo o canal aberto e o canal de voz em que você está.
  const rows = collapsed ? list.filter((c) => c.id === activeId || c.id === inVoice) : list;
  // Quem gerencia canais arrasta para reordenar (dentro da mesma lista, texto ou voz).
  const [drag, setDrag] = useState(null); // canal sendo arrastado
  const [drop, setDrop] = useState(null); // { id, after }: onde ele vai cair
  const canDrag = canManage && !collapsed && !isTouch;
  const dragProps = (c) =>
    canDrag
      ? {
          draggable: true,
          onDragStart: (e) => {
            e.dataTransfer.setData(DRAG_CHANNEL, c.id);
            e.dataTransfer.effectAllowed = 'move';
            setDrag(c.id);
          },
          onDragOver: (e) => {
            if (!drag || ![...e.dataTransfer.types].includes(DRAG_CHANNEL)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const r = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            if (drop?.id !== c.id || drop.after !== after) setDrop({ id: c.id, after });
          },
          onDrop: (e) => {
            if (!drag || !drop) return;
            e.preventDefault();
            const ids = list.map((x) => x.id).filter((id) => id !== drag);
            const at = ids.indexOf(drop.id);
            ids.splice(at < 0 ? ids.length : at + (drop.after ? 1 : 0), 0, drag);
            if (ids.some((id, i) => id !== list[i].id)) useStore.getState().orderChannels(guildId, type, ids);
            setDrag(null);
            setDrop(null);
          },
          onDragEnd: () => {
            setDrag(null);
            setDrop(null);
          },
        }
      : {};
  return (
    <>
      {menu && <ChannelMenu x={menu.x} y={menu.y} channel={menu.channel} guildId={guildId} onClose={() => setMenu(null)} />}
      <GroupHeader title={`${title} (${list.length})`} collapsed={collapsed} onToggle={toggle}>
        {canManage && (
          <button
            className="grp-add"
            title="Criar canal"
            aria-label="Criar canal"
            onClick={() => openModal({ type: 'channel', guildId, channelType: type })}
          >
            <Plus size={14} />
          </button>
        )}
      </GroupHeader>
      {rows.map((c) => {
        const Wrap = type === 'voice' ? VoiceChannelRow : 'div';
        return (
        <Wrap key={c.id} {...(type === 'voice' ? { c } : {})}>
          <button
            className={`row channel${activeId === c.id ? ' sel active' : ''}${drag === c.id ? ' dragging' : ''}${
              drop?.id === c.id && drag !== c.id ? (drop.after ? ' drop-after' : ' drop-before') : ''
            }`}
            title={canDrag ? 'Arraste para mudar a ordem' : undefined}
            {...dragProps(c)}
            onClick={() => (type === 'text' ? selectTextChannel(c.id) : joinVoice(c.id))}
            onContextMenu={
              type === 'text'
                ? (e) => {
                    e.preventDefault();
                    setMenu({ channel: c, x: e.clientX, y: e.clientY });
                  }
                : undefined
            }
          >
            {type === 'text' ? <Hash size={16} /> : <Volume2 size={16} />}
            <span className="label-text">{c.name}</span>
            {c.private && <Lock size={12} className="ch-lock" aria-label="Canal privado" />}
            {alerts[c.id]?.n > 0 && activeId !== c.id && (
              <span className="badge ch-badge" aria-label={`${alerts[c.id].n} ${alerts[c.id].n === 1 ? 'aviso' : 'avisos'}`}>
                {alerts[c.id].n > 99 ? '99+' : alerts[c.id].n}
              </span>
            )}
            {canManage && (
              <span
                className="ch-del ch-edit"
                role="button"
                title="Editar canal"
                aria-label={`Editar ${c.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openModal({ type: 'channel', guildId, channelType: type, channelId: c.id });
                }}
              >
                <Pencil size={13} />
              </span>
            )}
            {canManage && (
              <span
                className="ch-del"
                role="button"
                title="Excluir canal"
                onClick={(e) => {
                  e.stopPropagation();
                  openModal({
                    type: 'confirm',
                    title: `Excluir #${c.name}?`,
                    text: 'O canal e todas as mensagens serão apagados.',
                    action: () => deleteChannel(c.id),
                  });
                }}
              >
                <Trash2 size={14} />
              </span>
            )}
          </button>
          {type === 'voice' && <VoiceChannelMembers channelId={c.id} guildId={guildId} />}
        </Wrap>
        );
      })}
    </>
  );
}

export function ChannelSidebar() {
  const guildId = useStore((s) => s.currentGuildId);
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const data = useStore((s) => s.guildData[s.currentGuildId]);
  const view = useStore((s) => s.view);
  const me = useStore((s) => s.me);
  const sidebarView = useStore((s) => s.sidebarView);
  const phone = useLayout() === 'phone';
  const { openModal, toggleMusicPanel } = useStore.getState();
  const perms = usePerms(useStore, guildId);

  // Sons rápidos: sempre abaixo da lista (no celular, ficam na tela da chamada).
  const sounds = !phone && <SoundPanel />;

  if (!guild) {
    return (
      <aside className="sidebar glass" aria-label="Amigos e conversas">
        <HomeSidebar />
        {sounds}
        <VoiceStatus />
      </aside>
    );
  }

  if (sidebarView === 'music') {
    return (
      <aside className="sidebar glass music-side" aria-label="Fila de música">
        <MusicPanel />
        {/* No palco de voz o dock já tem os controles; fora dele, a caixa de voz continua à mão. */}
        {view?.type !== 'voice' && <VoiceStatus />}
      </aside>
    );
  }

  const text = data?.channels.filter((c) => c.type === 'text') || [];
  const voiceChannels = data?.channels.filter((c) => c.type === 'voice') || [];

  return (
    <aside className="sidebar glass" aria-label={`Canais de ${guild.name}`}>
      <div className="side-head">
        <div className="side-title">{guild.name}</div>
        <div className="side-actions">
          <button className="go" onClick={toggleMusicPanel} title="Fila de música">
            <Music size={14} />
            Música
          </button>
          {perms.invite && (
            <button className="gloss" onClick={() => openModal({ type: 'invite', guild })} title="Convidar pessoas">
              <UserPlus size={14} />
              Convidar
            </button>
          )}
          <button
            className="gloss"
            title="Configurações do servidor"
            aria-label="Configurações do servidor"
            onClick={() => openModal({ type: 'guildSettings', guildId: guild.id })}
          >
            <Settings size={14} />
          </button>
        </div>
      </div>
      <div className="channel-list">
        <ChannelGroup
          title="Canais de texto"
          type="text"
          list={text}
          canManage={perms.channels}
          guildId={guildId}
          activeId={view?.channelId}
        />
        <ChannelGroup
          title="Canais de voz"
          type="voice"
          list={voiceChannels}
          canManage={perms.channels}
          guildId={guildId}
          activeId={view?.channelId}
        />
      </div>
      {sounds}
      <VoiceStatus />
    </aside>
  );
}

export function VoiceStatus() {
  const vc = useVoiceConn();
  const voice = vc((s) => s.voice);
  const channel = vc((s) =>
    s.voice ? s.guildData[s.voice.guildId]?.channels.find((c) => c.id === s.voice.channelId) : null,
  );
  const guild = vc((s) => s.guilds.find((g) => g.id === s.voice?.guildId));
  const dm = vc((s) => (s.voice?.dm ? s.dms.find((d) => d.id === s.voice.channelId) : null));
  const ping = useServerPing(Boolean(voice), vc);
  if (!voice) return null;
  const { showVoice, leaveVoice, toggleCamera, toggleScreen, openModal } = vc.getState();
  const connected = voice.peers.every((p) => p.connectionState === 'connected');
  const calling = voice.dm && voice.peers.length === 0;
  const where = dm ? `Chamada com ${plain(dm.recipient.displayName)}` : `${channel?.name} · ${guild?.name}`;
  return (
    <div className={`voice-status${connected && !calling ? '' : ' pending'}`}>
      <button className="conn" onClick={showVoice} title="Abrir chamada">
        <b>
          <Orb status={connected && !calling ? 'on' : 'off'} />
          {calling ? 'Chamando…' : connected ? 'Voz conectada' : 'Conectando…'}
        </b>
        <span>
          {where}
          {ping != null ? ` · ${ping} ms` : ''}
        </span>
      </button>
      <div className="actions">
        <button
          className={voice.video ? 'go' : 'gloss'}
          onClick={toggleCamera}
          title={voice.video ? 'Desligar câmera' : 'Ligar câmera'}
          aria-label="Câmera"
          aria-pressed={voice.video}
        >
          <Video size={16} />
        </button>
        {!isTouch && (
        <button
          className={voice.screen ? 'go' : 'gloss'}
          onClick={() => toggleScreen()}
          title={voice.screen ? 'Parar transmissão' : 'Compartilhar tela'}
          aria-label="Compartilhar tela"
          aria-pressed={voice.screen}
        >
          <MonitorUp size={16} />
        </button>
        )}
        {!isTouch && voice.screen && (
          <button
            className="gloss"
            onClick={() => vc.getState().switchScreen()}
            title="Trocar a transmissão: outra janela ou a tela inteira, sem parar"
            aria-label="Trocar a transmissão"
          >
            <RefreshCw size={16} />
          </button>
        )}
        <button
          className="gloss"
          onClick={() => openModal({ type: 'diagnostics' })}
          title="Diagnóstico da chamada"
          aria-label="Diagnóstico da chamada"
        >
          <Activity size={16} />
        </button>
        <button className="stop" onClick={leaveVoice} title="Desconectar" aria-label="Desconectar">
          <PhoneOff size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------- Membros, como lista de contatos ----------

function MemberRow({ m, isOn, ownerId, admin }) {
  const activity = useActivity(m.id);
  const game = useGame(m.id);
  const liveIn = useStore(
    (s) => Object.entries(s.voiceStates).find(([, l]) => l.some((p) => p.user.id === m.id && p.screen))?.[0],
  );
  const live = Boolean(liveIn);
  const fresh = useStore((s) => s.users[m.id]) || m;
  const meId = useStore((s) => s.me?.id);
  const userMenu = useUserMenu(fresh);
  return (
    <>
    {userMenu.menu}
    <button
      className={`row member${isOn ? '' : ' offline'}`}
      title={live && m.id !== meId ? 'Assistir a transmissão' : undefined}
      onClick={() => (live && m.id !== meId ? useStore.getState().watchStream(liveIn, m.id) : openProfile(m.id))}
      onContextMenu={userMenu.onContextMenu}
    >
      <Avatar user={m} size={30} />
      <span className="member-text">
        <span className="member-name">
          <UserName user={m} className="nm" />
          {ownerId === m.id && <Crown size={13} className="crown" aria-label="Dono" />}
          {ownerId !== m.id && admin && <Shield size={13} className="crown admin-badge" aria-label="Administrador" />}
          {live && <span className="live">AO VIVO</span>}
        </span>
        {isOn && (game || fresh.bio || activity) && (
          <span className={`pm${game ? ' playing' : ''}`}>
            {game ? <Gamepad2 size={13} aria-hidden="true" /> : null}
            <FormattedText text={game || fresh.bio || activity} size={14} />
          </span>
        )}
      </span>
    </button>
    </>
  );
}

function MemberList({ onClose, overlay = true }) {
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const members = useStore((s) => s.guildData[s.currentGuildId]?.members) || [];
  const memberPerms = useStore((s) => s.guildData[s.currentGuildId]?.perms) || NO_PERMS;
  const online = useStore((s) => s.online);
  const on = members.filter((m) => online[m.id]);
  const off = members.filter((m) => !online[m.id]);
  const [onCollapsed, toggleOn] = useCollapsed('members:online');
  const [offCollapsed, toggleOff] = useCollapsed('members:offline');
  return (
    <aside className={`members glass${onClose && overlay ? ' members-over' : ''}${onClose && !overlay ? ' members-side' : ''}`} aria-label="Membros">
      <div className="panel-head">
        <span>Membros de {guild?.name}</span>
        {onClose && (
          <button className="gloss mini" onClick={onClose} title={overlay ? 'Fechar' : 'Recolher'} aria-label={overlay ? 'Fechar membros' : 'Recolher membros'}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="members-list">
        <GroupHeader title={`Online (${on.length})`} collapsed={onCollapsed} onToggle={toggleOn} />
        {!onCollapsed && on.map((m) => (
          <MemberRow key={m.id} m={m} isOn ownerId={guild?.ownerId} admin={(memberPerms[m.id] & 1) !== 0} />
        ))}
        {off.length > 0 && <GroupHeader title={`Offline (${off.length})`} collapsed={offCollapsed} onToggle={toggleOff} />}
        {!offCollapsed && off.map((m) => (
          <MemberRow key={m.id} m={m} isOn={false} ownerId={guild?.ownerId} admin={(memberPerms[m.id] & 1) !== 0} />
        ))}
      </div>
    </aside>
  );
}

// ---------- Área principal ----------

export function Main() {
  const view = useStore((s) => s.view);
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const canInvite = usePerms(useStore, guild?.id).invite;
  const channel = useStore((s) => s.guildData[s.currentGuildId]?.channels.find((c) => c.id === s.view?.channelId));
  const onlineCount = useStore(
    (s) => (s.guildData[s.currentGuildId]?.members || []).filter((m) => s.online[m.id]).length,
  );
  const guilds = useStore((s) => s.guilds);
  const desktopMembers = useStore((s) => s.showMembers);
  const membersOpen = useStore((s) => s.membersOpen);
  const voiceMembersOpen = useStore((s) => s.voiceMembersOpen);
  const home = useStore((s) => s.currentGuildId == null);
  const { openModal } = useStore.getState();
  const layout = useLayout();
  // Em telas estreitas (celular, tablet, janela pequena) a lista de membros abre por cima da conversa.
  const narrow = useNarrow();
  const showMembers = narrow ? membersOpen : desktopMembers;
  const toggleMembers = () =>
    useStore.setState(narrow ? { membersOpen: !membersOpen } : { showMembers: !desktopMembers });

  if (home) {
    if (view?.type === 'dm') return <DmView key={`${view.conn}:${view.channelId}`} dmId={view.channelId} conn={view.conn} />;
    return <FriendsPage />;
  }

  if (!guilds.length || !guild) {
    return (
      <main className="main glass">
        <div className="empty">
          <div>
            <h2>Nenhum servidor ainda</h2>
            <p>Crie um servidor ou entre com um convite para começar a conversar.</p>
            <button className="btn" onClick={() => openModal({ type: 'guild' })}>
              <Plus size={18} /> Adicionar servidor
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (view?.type === 'voice' && channel) {
    const open = useStore.getState().voiceMembersOpen;
    return (
      <>
        <main className="main stage-main">
          <VoiceView channel={channel} />
        </main>
        {/* Membros também na tela de voz: começam recolhidos numa faixa estreita. */}
        {voiceMembersOpen ? (
          <MemberList onClose={() => useStore.setState({ voiceMembersOpen: !open })} overlay={narrow} />
        ) : (
          <button
            className="members-mini glass"
            onClick={() => useStore.setState({ voiceMembersOpen: true })}
            title="Mostrar membros"
            aria-label={`Mostrar membros (${onlineCount} online)`}
          >
            <Users size={18} className="ico-purple" />
            <span>Membros</span>
            <b>{onlineCount}</b>
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <main className="main glass">
        <header className="main-header">
          {layout === 'phone' && <MobileBack />}
          <Hash size={20} className="head-ico" />
          <div className="head-text">
            <b>{channel?.name || ''}</b>
            <span>
              {guild.name} · {onlineCount} online agora
            </span>
          </div>
          <div className="head-tools">
            {canInvite && (
              <button className="gloss tool" onClick={() => openModal({ type: 'invite', guild })}>
                <Link2 size={20} className="ico-blue" />
                Convite
              </button>
            )}
            {view?.type === 'text' && (
              <button
                className={`gloss tool${showMembers ? ' pressed' : ''}`}
                aria-pressed={showMembers}
                title="Membros"
                onClick={toggleMembers}
              >
                <Users size={20} className="ico-purple" />
                Membros
              </button>
            )}
          </div>
        </header>
        {view?.type === 'text' && channel ? (
          <ChatView channel={channel} />
        ) : (
          <div className="empty">Selecione um canal.</div>
        )}
      </main>
      {view?.type === 'text' && showMembers && (
        <MemberList onClose={narrow ? () => useStore.setState({ membersOpen: false }) : undefined} />
      )}
    </>
  );
}

/** Tablet na vertical: servidores e conversas numa gaveta que abre pelo ☰. */
function TabletShell() {
  const [open, setOpen] = useState(false);
  const pane = useStore((s) => s.mobilePane);
  // Abriu uma conversa, canal ou chamada pela gaveta: ela fecha e mostra o que foi aberto.
  useEffect(() => {
    if (pane !== 'detail') return;
    setOpen(false);
    useStore.setState({ mobilePane: 'list' });
  }, [pane]);
  return (
    <div className="aero-app tablet-app" {...useAppBackground()}>
      <ProfileBar onMenu={() => setOpen(true)} />
      <DownloadBanner />
      <div className="aero-body">
        <Main />
      </div>
      {open && <div className="t-scrim" onClick={() => setOpen(false)} />}
      <div className={`t-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        <GuildRail />
        <ChannelSidebar />
      </div>
    </div>
  );
}

/**
 * Imagem de fundo da janela: a minha no Início, a do servidor dentro dele. Cobre a janela toda
 * (aumenta e corta as sobras, sem faixas pretas).
 */
export function useAppBackground() {
  const home = useStore((s) => s.currentGuildId == null);
  const guildBg = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId)?.backgroundUrl);
  const base = useStore((s) => s.baseUrl);
  const prim = primaryConn();
  const myBg = prim((s) => s.myBackground);
  const primBase = prim((s) => s.baseUrl);
  const url = home ? myBg && primBase + myBg : guildBg && base + guildBg;
  return url ? { 'data-bg': '1', style: { '--app-bg-img': `url("${url}")` } } : {};
}

/**
 * Faixa "Baixe o app para Windows" (só no navegador de um computador com Windows). O X esconde por
 * uma semana; depois ela volta.
 */
const BANNER_KEY = 'padospeak.downloadBannerClosedAt';
const BANNER_AGAIN_MS = 7 * 24 * 3600 * 1000;
export function DownloadBanner() {
  const [closed, setClosed] = useState(() => {
    try {
      const at = Number(localStorage.getItem(BANNER_KEY));
      return at > 0 && Date.now() - at < BANNER_AGAIN_MS;
    } catch {
      return false;
    }
  });
  if (!offerWindowsApp || closed) return null;
  return (
    <div className="dl-banner" role="region" aria-label="Baixar o app para Windows">
      <img className="dl-ico" src="/icons/icon-192.png" alt="" />
      <span className="dl-text">
        <b>Baixe o app para Windows</b>
      </span>
      <a className="btn" href={DOWNLOAD_URL}>
        <Download size={15} /> Baixar o app
      </a>
      <button
        type="button"
        className="dl-close"
        title="Fechar"
        aria-label="Fechar"
        onClick={() => {
          setClosed(true);
          try {
            localStorage.setItem(BANNER_KEY, String(Date.now()));
          } catch {
            /* sem armazenamento: só fecha agora */
          }
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export default function Shell() {
  const layout = useLayout();
  const bg = useAppBackground();
  if (layout === 'phone') return <MobileShell />;
  if (layout === 'tablet') return <TabletShell />;
  return (
    <div className="aero-app" {...bg}>
      <ProfileBar />
      <DownloadBanner />
      <div className="aero-body">
        <GuildRail />
        <ChannelSidebar />
        <Main />
      </div>
    </div>
  );
}
