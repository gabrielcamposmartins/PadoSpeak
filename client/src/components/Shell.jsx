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
  DoorOpen,
  Crown,
  Users,
  Music,
  ChevronDown,
  AudioWaveform,
  Activity,
  Link2,
} from 'lucide-react';
import { useStore, primaryConn, setStatusEverywhere, connRegistry } from '../store.js';
import { isDesktop } from '../lib/env.js';
import { ConnProvider, useAcross, useVoiceConn } from './conn.jsx';
import { canHost } from '../lib/host.js';
import { useRef, useState } from 'react';
import Avatar, { UserName, Orb, useActivity, STATUS_INFO, colorClass, colorStyle } from './Avatar.jsx';
import { SceneArt, BuddiesIcon } from './Aero.jsx';
import { HomeSidebar, FriendsPage, DmView } from './Home.jsx';
import ChatView from './ChatView.jsx';
import VoiceView from './VoiceView.jsx';
import { useServerPing } from './hooks.js';
import MusicPanel from './MusicPanel.jsx';
import { FormattedText, Floating } from './Emotes.jsx';
import { plain } from '../lib/text.js';

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
function StatusMenu({ status, label }) {
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

function ProfileBar() {
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
      : channel
        ? `${voice.screen ? `${statusLabel} · ao vivo` : statusLabel} · em ${channel.name}`
        : statusLabel;

  return (
    <header className="profile-bar scene">
      <SceneArt />
      <Avatar user={me} base={base} size={62} status={frame} speaking={voice?.speaking.me} onClick={() => openModal({ type: 'editProfile' })} />
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

function GuildRail() {
  const guilds = useStore((s) => s.guilds);
  const current = useStore((s) => s.currentGuildId);
  const { selectGuild, openModal, goHost, goHome } = useStore.getState();
  const unread = useAcross((states) =>
    states.reduce((n, st) => n + Object.values(st.unread).reduce((a, b) => a + b, 0), 0),
  );
  const pending = useStore((s) => Object.values(s.friends).filter((f) => f.status === 'incoming').length);
  const badge = unread + pending;
  return (
    <nav className="guild-rail glass" aria-label="Servidores">
      <div className={`gel-slot${current == null ? ' active' : ''}`}>
        <button
          className="gel home guild-icon"
          title="Início — amigos e conversas"
          aria-label="Início: amigos e conversas"
          onClick={goHome}
        >
          <BuddiesIcon />
        </button>
        {badge > 0 && <span className="badge guild-badge">{badge > 99 ? '99+' : badge}</span>}
      </div>
      <div className="rail-sep" />
      {guilds.map((g) => (
        <div key={g.id} className={`gel-slot${g.id === current ? ' active' : ''}`}>
          <button
            className="gel guild guild-icon"
            style={{ '--c': g.iconColor }}
            title={g.name}
            aria-label={g.name}
            onClick={() => selectGuild(g.id)}
          >
            <span>{initials(g.name)}</span>
          </button>
        </div>
      ))}
      <button
        className="gel add"
        title="Criar ou entrar em um servidor"
        aria-label="Criar ou entrar em um servidor"
        onClick={() => openModal({ type: 'guild' })}
      >
        <Plus size={22} strokeWidth={2.6} />
      </button>
      <span className="rail-fill" />
      {(canHost || isDesktop) && (
        <button className="gel host" title="Hostear servidor" aria-label="Hostear servidor" onClick={goHost}>
          <Server size={20} />
        </button>
      )}
    </nav>
  );
}

// ---------- Canais ----------

function VoiceChannelMembers({ channelId }) {
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
      {participants.map((p) => {
        const speaking = inThisCall && (p.peerId === voice.selfId ? voice.speaking.me : voice.speaking[p.peerId]);
        return (
          <div className="voice-member" key={p.peerId}>
            <Avatar
              user={p.user}
              size={20}
              status={p.screen ? 'live' : 'voice'}
              speaking={speaking}
              onClick={() => openProfile(p.user.id)}
            />
            <UserName user={p.user} className="nm" />
            {p.screen && <span className="live">AO VIVO</span>}
            {p.video && <Video size={14} />}
            {p.deafened ? (
              <HeadphoneOff size={14} className="muted-ico" aria-label="ensurdecido" />
            ) : p.muted ? (
              <MicOff size={14} className="muted-ico" aria-label="mutado" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ChannelGroup({ title, type, list, isOwner, guildId, activeId }) {
  const { selectTextChannel, joinVoice, openModal, deleteChannel } = useStore.getState();
  return (
    <>
      <div className="grp">
        <ChevronDown size={12} />
        <span className="grp-title">
          {title} ({list.length})
        </span>
        {isOwner && (
          <button
            className="grp-add"
            title="Criar canal"
            aria-label="Criar canal"
            onClick={() => openModal({ type: 'channel', guildId, channelType: type })}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {list.map((c) => (
        <div key={c.id}>
          <button
            className={`row channel${activeId === c.id ? ' sel active' : ''}`}
            onClick={() => (type === 'text' ? selectTextChannel(c.id) : joinVoice(c.id))}
          >
            {type === 'text' ? <Hash size={16} /> : <Volume2 size={16} />}
            <span className="label-text">{c.name}</span>
            {isOwner && (
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
          {type === 'voice' && <VoiceChannelMembers channelId={c.id} />}
        </div>
      ))}
    </>
  );
}

function ChannelSidebar() {
  const guildId = useStore((s) => s.currentGuildId);
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const data = useStore((s) => s.guildData[s.currentGuildId]);
  const view = useStore((s) => s.view);
  const me = useStore((s) => s.me);
  const sidebarView = useStore((s) => s.sidebarView);
  const { openModal, toggleMusicPanel } = useStore.getState();
  const isOwner = guild?.ownerId === me?.id;

  if (!guild) {
    return (
      <aside className="sidebar glass" aria-label="Amigos e conversas">
        <HomeSidebar />
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
          <button className="gloss" onClick={() => openModal({ type: 'invite', guild })} title="Convidar pessoas">
            <UserPlus size={14} />
            Convidar
          </button>
          <button
            className="gloss danger-ico"
            title={isOwner ? 'Excluir servidor' : 'Sair do servidor'}
            aria-label={isOwner ? 'Excluir servidor' : 'Sair do servidor'}
            onClick={() =>
              openModal({
                type: 'confirm',
                title: isOwner ? `Excluir "${guild.name}"?` : `Sair de "${guild.name}"?`,
                text: isOwner
                  ? 'Todos os canais e mensagens serão apagados para sempre.'
                  : 'Você precisará de um novo convite para voltar.',
                action: () =>
                  isOwner ? useStore.getState().deleteGuild(guild.id) : useStore.getState().leaveGuild(guild.id),
              })
            }
          >
            {isOwner ? <Trash2 size={14} /> : <DoorOpen size={14} />}
          </button>
        </div>
      </div>
      <div className="channel-list">
        <ChannelGroup
          title="Canais de texto"
          type="text"
          list={text}
          isOwner={isOwner}
          guildId={guildId}
          activeId={view?.channelId}
        />
        <ChannelGroup
          title="Canais de voz"
          type="voice"
          list={voiceChannels}
          isOwner={isOwner}
          guildId={guildId}
          activeId={view?.channelId}
        />
      </div>
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
        <button
          className={voice.screen ? 'go' : 'gloss'}
          onClick={() => toggleScreen()}
          title={voice.screen ? 'Parar transmissão' : 'Compartilhar tela'}
          aria-label="Compartilhar tela"
          aria-pressed={voice.screen}
        >
          <MonitorUp size={16} />
        </button>
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

function MemberRow({ m, isOn, ownerId }) {
  const activity = useActivity(m.id);
  const live = useStore((s) => Object.values(s.voiceStates).some((l) => l.some((p) => p.user.id === m.id && p.screen)));
  const fresh = useStore((s) => s.users[m.id]) || m;
  return (
    <button className={`row member${isOn ? '' : ' offline'}`} onClick={() => openProfile(m.id)}>
      <Avatar user={m} size={30} />
      <span className="member-text">
        <span className="member-name">
          <UserName user={m} className="nm" />
          {ownerId === m.id && <Crown size={13} className="crown" aria-label="Dono" />}
          {live && <span className="live">AO VIVO</span>}
        </span>
        {isOn && (fresh.bio || activity) && (
          <span className="pm">
            <FormattedText text={fresh.bio || activity} size={14} />
          </span>
        )}
      </span>
    </button>
  );
}

function MemberList() {
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const members = useStore((s) => s.guildData[s.currentGuildId]?.members) || [];
  const online = useStore((s) => s.online);
  const on = members.filter((m) => online[m.id]);
  const off = members.filter((m) => !online[m.id]);
  return (
    <aside className="members glass" aria-label="Membros">
      <div className="panel-head">Membros de {guild?.name}</div>
      <div className="members-list">
        <div className="grp">
          <ChevronDown size={12} />
          <span className="grp-title">Online ({on.length})</span>
        </div>
        {on.map((m) => (
          <MemberRow key={m.id} m={m} isOn ownerId={guild?.ownerId} />
        ))}
        {off.length > 0 && (
          <div className="grp">
            <ChevronDown size={12} />
            <span className="grp-title">Offline ({off.length})</span>
          </div>
        )}
        {off.map((m) => (
          <MemberRow key={m.id} m={m} isOn={false} ownerId={guild?.ownerId} />
        ))}
      </div>
    </aside>
  );
}

// ---------- Área principal ----------

function Main() {
  const view = useStore((s) => s.view);
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const channel = useStore((s) => s.guildData[s.currentGuildId]?.channels.find((c) => c.id === s.view?.channelId));
  const onlineCount = useStore(
    (s) => (s.guildData[s.currentGuildId]?.members || []).filter((m) => s.online[m.id]).length,
  );
  const guilds = useStore((s) => s.guilds);
  const showMembers = useStore((s) => s.showMembers);
  const home = useStore((s) => s.currentGuildId == null);
  const { openModal } = useStore.getState();

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
    return (
      <main className="main stage-main">
        <VoiceView channel={channel} />
      </main>
    );
  }

  return (
    <>
      <main className="main glass">
        <header className="main-header">
          <Hash size={20} className="head-ico" />
          <div className="head-text">
            <b>{channel?.name || ''}</b>
            <span>
              {guild.name} · {onlineCount} online agora
            </span>
          </div>
          <div className="head-tools">
            <button className="gloss tool" onClick={() => openModal({ type: 'invite', guild })}>
              <Link2 size={20} className="ico-blue" />
              Convite
            </button>
            {view?.type === 'text' && (
              <button
                className={`gloss tool${showMembers ? ' pressed' : ''}`}
                aria-pressed={showMembers}
                title="Membros"
                onClick={() => useStore.setState({ showMembers: !showMembers })}
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
      {view?.type === 'text' && showMembers && <MemberList />}
    </>
  );
}

export default function Shell() {
  return (
    <div className="aero-app">
      <ProfileBar />
      <div className="aero-body">
        <GuildRail />
        <ChannelSidebar />
        <Main />
      </div>
    </div>
  );
}
