import { useState } from 'react';
import {
  Plus,
  MessageSquare,
  Phone,
  Video,
  Check,
  X,
  UserPlus,
  AtSign,
  ChevronDown,
  UserRound,
  Wifi,
  Server,
  LogIn,
} from 'lucide-react';
import { useStore, connRegistry, openLanDm, changeServer } from '../store.js';
import { isDesktop } from '../lib/env.js';
import Avatar, { Orb, useUser, usePresence, useActivity, UserName, STATUS_INFO, colorClass, colorStyle } from './Avatar.jsx';
import ChatView from './ChatView.jsx';
import VoiceView from './VoiceView.jsx';
import { EmojiText } from './Emotes.jsx';
import { ConnProvider, useConn, useConnKey } from './conn.jsx';

/** Referência estável: seletores do zustand não podem devolver um array novo a cada leitura. */
const NOBODY = [];
const EMPTY_PEERS = [];

const openProfile = (userId, conn) => useStore.getState().openModal({ type: 'profile', userId, conn });

/** Etiqueta dos perfis da rede local. */
export function LanTag() {
  return (
    <span className="lan-tag" title="Perfil de outro PC da rede local">
      LAN
    </span>
  );
}

/** Mensagem pessoal com a cor escolhida pela pessoa (ou um texto qualquer, sem cor). */
function Bio({ user, text, size = 14 }) {
  return (
    <span className={colorClass(text ? null : user?.bioColor, 'pm')} style={text ? undefined : colorStyle(user?.bioColor)}>
      <EmojiText text={text ?? user?.bio} size={size} />
    </span>
  );
}

/** Entra no servidor que outro PC da rede está hospedando. */
async function joinHostedServer(peer) {
  const ui = useStore.getState();
  await changeServer(peer.hosting.url);
  const status = useStore.getState().serverStatus;
  if (status === 'login' || status === 'mismatch') ui.openModal({ type: 'serverLogin' });
  else if (status === 'unreachable') ui.notify(`Não foi possível conectar a ${peer.hosting.url}`);
}

// ---------- Barra lateral do Início: abas, pedidos, conversas, rede local e amigos ----------

const TABS = [
  ['online', 'Online'],
  ['all', 'Todos'],
  ['pending', 'Pendentes'],
];

function FriendTabs() {
  const tab = useStore((s) => s.friendsTab);
  const pending = useStore((s) => Object.values(s.friends).filter((f) => f.status === 'incoming').length);
  const { setFriendsTab, goHome } = useStore.getState();
  const pick = (id) => {
    setFriendsTab(id);
    goHome();
  };
  return (
    <div className="tabs-wrap">
      <div className="aero-tabs friend-tabs" role="tablist" aria-label="Amigos">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' on' : ''}`} onClick={() => pick(id)}>
            {label}
            {id === 'pending' && pending > 0 && <span className="badge small">{pending}</span>}
          </button>
        ))}
        <button
          role="tab"
          aria-selected={tab === 'add'}
          className={`tab add${tab === 'add' ? ' on' : ''}`}
          title="Adicionar amigo"
          aria-label="Adicionar amigo"
          onClick={() => pick('add')}
        >
          <UserPlus size={15} />
        </button>
      </div>
    </div>
  );
}

function RequestRow({ entry }) {
  const user = useUser(entry.user);
  const { acceptFriend, removeFriend } = useStore.getState();
  return (
    <div className="request-row">
      <Avatar user={user} size={28} onClick={() => openProfile(user.id)} />
      <div className="request-text">
        <b>
          <UserName user={user} />
        </b>
        <span>quer ser seu amigo</span>
      </div>
      <button
        className="go mini"
        title="Aceitar"
        aria-label={`Aceitar pedido de ${user.displayName}`}
        onClick={() => acceptFriend(user.id)}
      >
        <Check size={14} />
      </button>
      <button
        className="gloss mini danger-ico"
        title="Recusar"
        aria-label={`Recusar pedido de ${user.displayName}`}
        onClick={() => removeFriend(user.id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

function DmRow({ dm, active }) {
  const useC = useConn();
  const lan = useC((s) => s.kind !== 'server');
  const recipient = useUser(dm.recipient);
  const unread = useC((s) => s.unread[dm.id] || 0);
  const inCall = useC((s) => Boolean(s.voiceStates[dm.id]?.length));
  const activity = useActivity(recipient.id);
  const status = usePresence(recipient.id);
  return (
    <button
      className={`row dm-row${active ? ' sel active' : ''}${status === 'off' ? ' offline' : ''}`}
      onClick={() => useC.getState().selectDm(dm.id)}
    >
      <Avatar user={recipient} size={30} />
      <span className="member-text">
        <span className="member-name">
          <UserName user={recipient} className="nm label-text" />
          {lan && <LanTag />}
          {inCall && <Phone size={13} className="dm-call-icon" aria-label="em chamada" />}
        </span>
        {activity ? <Bio text={activity} /> : recipient.bio ? <Bio user={recipient} /> : null}
      </span>
      {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

/** Conversas diretas de uma conexão (servidor, perfil local ou PC da rede). */
function ConnDms() {
  const useC = useConn();
  const conn = useConnKey();
  const dms = useC((s) => s.dms);
  const view = useStore((s) => s.view);
  return dms.map((dm) => (
    <DmRow key={dm.id} dm={dm} active={view?.type === 'dm' && view.channelId === dm.id && (view.conn || 'server') === conn} />
  ));
}

function FriendOrbRow({ entry }) {
  const user = useUser(entry.user);
  const status = usePresence(user.id);
  const label = { voice: 'em voz', live: 'ao vivo', away: 'ausente', busy: 'ocupado' }[status];
  return (
    <button className="row orb-row" onClick={() => useStore.getState().openDm(user.id)} title={`Conversar com ${user.displayName}`}>
      <Orb status={status} />
      <UserName user={user} className="nm" />
      {label && <span className={`orb-note ${status}`}>{label}</span>}
    </button>
  );
}

function LanPeerRow({ peer }) {
  const status = STATUS_INFO[peer.status]?.cls || 'on';
  return (
    <div className="lan-row">
      <button className="row lan-open" onClick={() => openLanDm(peer)} title={`Conversar com ${peer.displayName}`}>
        <Avatar user={peer} size={30} status={status} />
        <span className="member-text">
          <span className="member-name">
            <UserName user={peer} className="nm" />
            <LanTag />
          </span>
          {peer.hosting ? <Bio text={`Hospedando “${peer.hosting.name}”`} /> : peer.bio ? <Bio user={peer} /> : null}
        </span>
      </button>
      {peer.hosting && (
        <button
          className="gloss mini"
          title={`Entrar no servidor ${peer.hosting.name}`}
          aria-label={`Entrar no servidor ${peer.hosting.name}`}
          onClick={() => joinHostedServer(peer)}
        >
          <LogIn size={13} />
        </button>
      )}
    </div>
  );
}

/** Perfis da rede local (do nó local), ou nada no navegador. */
function useLanPeers() {
  const hasLocal = useStore((s) => s.connKeys.includes('local'));
  const local = hasLocal ? connRegistry.get('local') : useStore;
  const peers = local((s) => (hasLocal ? s.lanPeers : EMPTY_PEERS));
  return hasLocal ? peers : null;
}

/** Perfis encontrados na rede local (só no app desktop). */
function LanSection() {
  const peers = useLanPeers();
  if (!peers) return null;
  return (
    <>
      <div className="grp">
        <Wifi size={12} />
        <span className="grp-title">Na rede local ({peers.length})</span>
      </div>
      {peers.length === 0 && <p className="home-empty-dm">Ninguém com o PadoSpeak aberto nesta rede agora.</p>}
      {peers.map((p) => (
        <LanPeerRow key={p.id} peer={p} />
      ))}
    </>
  );
}

export function HomeSidebar() {
  const connKeys = useStore((s) => s.connKeys);
  // Muda quando qualquer conexão ganha ou perde conversas.
  const dmCount = useStore(() => [...connRegistry.values()].reduce((n, c) => n + c.getState().dms.length, 0));
  const tab = useStore((s) => s.friendsTab);
  const friends = useStore((s) => s.friends);
  const online = useStore((s) => s.online);
  const all = Object.values(friends).sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
  const incoming = all.filter((f) => f.status === 'incoming');
  const mates = all.filter((f) => f.status === 'friend');
  const shown = tab === 'online' ? mates.filter((f) => online[f.user.id]) : mates;
  return (
    <>
      <FriendTabs />
      <div className="channel-list home-list">
        {incoming.length > 0 && (
          <>
            <div className="grp">
              <ChevronDown size={12} />
              <span className="grp-title">Pedidos de amizade ({incoming.length})</span>
            </div>
            {incoming.map((f) => (
              <RequestRow key={f.user.id} entry={f} />
            ))}
          </>
        )}
        <div className="grp">
          <ChevronDown size={12} />
          <span className="grp-title">Conversas ({dmCount})</span>
          <button
            className="grp-add"
            title="Nova conversa"
            aria-label="Nova conversa"
            onClick={() => useStore.getState().openModal({ type: 'newDm' })}
          >
            <Plus size={14} />
          </button>
        </div>
        {dmCount === 0 && <p className="home-empty-dm">Suas conversas aparecem aqui.</p>}
        {connKeys.map((k) => (
          <ConnProvider key={k} conn={k}>
            <ConnDms />
          </ConnProvider>
        ))}
        <LanSection />
        <div className="grp">
          <ChevronDown size={12} />
          <span className="grp-title">
            {tab === 'online' ? 'Amigos online' : 'Amigos'} ({shown.length})
          </span>
        </div>
        {shown.length === 0 && (
          <p className="home-empty-dm">{tab === 'online' ? 'Nenhum amigo online agora.' : 'Nenhum amigo ainda.'}</p>
        )}
        {shown.map((f) => (
          <FriendOrbRow key={f.user.id} entry={f} />
        ))}
      </div>
    </>
  );
}

// ---------- Página de amigos (Início sem conversa aberta) ----------

function FriendRow({ entry }) {
  const user = useUser(entry.user);
  const status = usePresence(user.id);
  const activity = useActivity(user.id);
  const { openDm, callUser, acceptFriend, removeFriend, openModal } = useStore.getState();
  const label = {
    friend: activity || STATUS_INFO[{ on: 'online', away: 'away', busy: 'busy' }[status]]?.label || 'Offline',
    incoming: 'Pedido de amizade recebido',
    outgoing: 'Pedido de amizade enviado',
  }[entry.status];
  const act = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className="friend-row" onClick={() => openProfile(user.id)}>
      <Avatar user={user} size={36} />
      <div className="friend-text">
        <b>
          <UserName user={user} />
        </b>
        <span>
          @{user.username} · {label}
        </span>
        {user.bio && <Bio user={user} />}
      </div>
      <div className="friend-actions">
        {entry.status === 'friend' && (
          <>
            <button className="gloss mini" title="Mensagem" aria-label="Mensagem" onClick={act(() => openDm(user.id))}>
              <MessageSquare size={16} />
            </button>
            <button className="gloss mini" title="Ligar" aria-label="Ligar" onClick={act(() => callUser(user.id))}>
              <Phone size={16} />
            </button>
            <button
              className="gloss mini danger-ico"
              title="Desfazer amizade"
              aria-label="Desfazer amizade"
              onClick={act(() =>
                openModal({
                  type: 'confirm',
                  title: `Desfazer amizade com ${user.displayName}?`,
                  text: '',
                  action: () => removeFriend(user.id),
                }),
              )}
            >
              <X size={16} />
            </button>
          </>
        )}
        {entry.status === 'incoming' && (
          <>
            <button className="go mini" title="Aceitar" aria-label="Aceitar" onClick={act(() => acceptFriend(user.id))}>
              <Check size={16} />
            </button>
            <button
              className="gloss mini danger-ico"
              title="Recusar"
              aria-label="Recusar"
              onClick={act(() => removeFriend(user.id))}
            >
              <X size={16} />
            </button>
          </>
        )}
        {entry.status === 'outgoing' && (
          <button
            className="gloss mini danger-ico"
            title="Cancelar pedido"
            aria-label="Cancelar pedido"
            onClick={act(() => removeFriend(user.id))}
          >
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Cartão de um perfil da rede local na página de amigos. */
function LanCard({ peer }) {
  const status = STATUS_INFO[peer.status]?.cls || 'on';
  return (
    <div className="friend-row" onClick={() => openLanDm(peer)}>
      <Avatar user={peer} size={36} status={status} />
      <div className="friend-text">
        <b>
          <UserName user={peer} /> <LanTag />
        </b>
        <span>
          @{peer.username} · {STATUS_INFO[peer.status]?.label || 'Online'} · {peer.nodeUrl.replace(/^https?:\/\//, '')}
        </span>
        {peer.hosting ? <Bio text={`Hospedando o servidor “${peer.hosting.name}”`} /> : peer.bio && <Bio user={peer} />}
      </div>
      <div className="friend-actions" onClick={(e) => e.stopPropagation()}>
        <button className="gloss mini" title="Mensagem" aria-label={`Mensagem para ${peer.displayName}`} onClick={() => openLanDm(peer)}>
          <MessageSquare size={16} />
        </button>
        <button
          className="gloss mini"
          title="Ligar"
          aria-label={`Ligar para ${peer.displayName}`}
          onClick={() => openLanDm(peer, { call: true })}
        >
          <Phone size={16} />
        </button>
        {peer.hosting && (
          <button className="go mini wide" title={`Entrar no servidor ${peer.hosting.name}`} onClick={() => joinHostedServer(peer)}>
            <LogIn size={14} /> Entrar
          </button>
        )}
      </div>
    </div>
  );
}

function AddFriend() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const online = useStore((s) => Boolean(s.me));
  return (
    <div className="add-friend">
      <h3>Adicionar amigo</h3>
      <p>
        {online
          ? 'Você pode adicionar amigos pelo nome de usuário (o que vem depois do @).'
          : 'Amigos ficam no servidor de comunidade: conecte-se a um para adicionar alguém. Quem está na sua rede local aparece sozinho, sem precisar adicionar.'}
      </p>
      <form
        className={`add-friend-box${error ? ' error' : ''}`}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await useStore.getState().sendFriendRequest(name);
            setName('');
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <AtSign size={18} />
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="nome_de_usuario"
          aria-label="Nome de usuário"
          disabled={!online}
        />
        <button className="btn" disabled={busy || !name.trim() || !online}>
          Enviar pedido
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** No app desktop: situação do servidor de comunidade (amigos e servidores moram nele). */
export function ServerNotice() {
  const status = useStore((s) => s.serverStatus);
  const url = useStore((s) => s.baseUrl);
  if (!isDesktop || status === 'online') return null;
  const host = url.replace(/^https?:\/\//, '');
  const text = {
    off: 'Sem servidor de comunidade.',
    connecting: `Conectando a ${host}…`,
    unreachable: `${host} não respondeu. Você está no modo local: conversas e chamadas com a rede local funcionam normalmente.`,
    login: `Entre na sua conta de ${host} para ver amigos e servidores.`,
    mismatch: `Seu perfil local não tem conta em ${host} com a mesma senha. Entre com a conta de lá (ou crie uma).`,
  }[status];
  return (
    <div className="no-guilds server-notice">
      <div>
        <b>
          <Server size={15} /> Servidor: {host}
        </b>
        <span>{text}</span>
      </div>
      {(status === 'login' || status === 'mismatch') && (
        <button className="btn" onClick={() => useStore.getState().openModal({ type: 'serverLogin' })}>
          <LogIn size={16} /> Entrar
        </button>
      )}
      <button className="btn secondary" onClick={() => useStore.getState().goHost()}>
        Configurar
      </button>
    </div>
  );
}

export function FriendsPage() {
  const tab = useStore((s) => s.friendsTab);
  const friends = useStore((s) => s.friends);
  const online = useStore((s) => s.online);
  const noGuilds = useStore((s) => s.guilds.length === 0);
  const serverOnline = useStore((s) => Boolean(s.me));
  const lanPeers = useLanPeers();
  const all = Object.values(friends).sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
  const list = {
    online: all.filter((f) => f.status === 'friend' && online[f.user.id]),
    all: all.filter((f) => f.status === 'friend'),
    pending: all.filter((f) => f.status !== 'friend'),
    add: [],
  }[tab];
  const empty = {
    online: 'Nenhum amigo online agora.',
    all: 'Você ainda não adicionou ninguém. Use a aba “Adicionar amigo” (o ícone com +).',
    pending: 'Nenhum pedido de amizade pendente.',
  }[tab];
  const title = { online: 'Amigos online', all: 'Todos os amigos', pending: 'Pedidos pendentes', add: 'Adicionar amigo' }[
    tab
  ];
  const showLan = lanPeers && (tab === 'online' || tab === 'all');

  return (
    <main className="main glass">
      <header className="main-header">
        <UserRound size={20} className="head-ico" />
        <div className="head-text">
          <b>{title}</b>
          <span>Amigos, conversas e chamadas 1 a 1</span>
        </div>
      </header>
      <div className="friends-body">
        <ServerNotice />
        {serverOnline && noGuilds && tab !== 'add' && (
          <div className="no-guilds">
            <div>
              <b>Você ainda não está em nenhum servidor</b>
              <span>Crie um servidor para seus amigos ou entre com um convite.</span>
            </div>
            <button className="btn" onClick={() => useStore.getState().openModal({ type: 'guild' })}>
              <Plus size={18} /> Adicionar servidor
            </button>
          </div>
        )}
        {showLan && lanPeers.length > 0 && (
          <>
            <div className="section-title">
              <Wifi size={14} /> Na rede local
            </div>
            {lanPeers.map((p) => (
              <LanCard key={p.id} peer={p} />
            ))}
            <div className="section-title">Amigos</div>
          </>
        )}
        {tab === 'add' ? (
          <AddFriend />
        ) : list.length === 0 ? (
          <div className="friends-empty">{empty}</div>
        ) : (
          list.map((f) => <FriendRow key={f.user.id} entry={f} />)
        )}
      </div>
    </main>
  );
}

// ---------- Conversa direta, como a janela do Messenger ----------

function PhotoCard({ user, label, onClick }) {
  const pic = <Avatar user={user} size={150} />;
  return (
    <div className="photo-card">
      {onClick ? (
        <button className="photo-btn" onClick={onClick} aria-label={`Ver perfil de ${user.displayName}`}>
          {pic}
        </button>
      ) : (
        pic
      )}
      <span>
        <EmojiText text={label} size={14} />
      </span>
    </div>
  );
}

export function DmView({ dmId, conn }) {
  return (
    <ConnProvider conn={conn}>
      <DmWindow dmId={dmId} />
    </ConnProvider>
  );
}

function DmWindow({ dmId }) {
  const useC = useConn();
  const conn = useConnKey();
  const dm = useC((s) => s.dms.find((d) => d.id === dmId));
  const voice = useC((s) => s.voice);
  const me = useC((s) => s.me);
  const recipient = useUser(dm?.recipient);
  const othersInCall = useC((s) => s.voiceStates[dmId]) || NOBODY;
  if (!dm || !me)
    return (
      <main className="main glass">
        <div className="empty">Carregando conversa…</div>
      </main>
    );

  const inCall = voice?.channelId === dmId;
  const channel = { id: dm.id, name: recipient.displayName, guildId: null, dm: true, recipient };
  const { joinVoice, toggleCamera } = useC.getState();
  const ringing = !inCall && othersInCall.length > 0;

  return (
    <main className="main glass dm-window">
      <div className="dm-actions">
        {!inCall && (
          <>
            <button
              className={`${ringing ? 'go' : 'gloss'} tool`}
              title={ringing ? 'Entrar na chamada' : 'Iniciar chamada de voz'}
              onClick={() => joinVoice(dmId)}
            >
              <Phone size={20} className={ringing ? '' : 'ico-green'} />
              {ringing ? 'Entrar' : 'Ligar'}
            </button>
            <button
              className="gloss tool"
              title="Iniciar chamada de vídeo"
              onClick={async () => {
                await joinVoice(dmId);
                if (useC.getState().voice?.channelId === dmId) toggleCamera();
              }}
            >
              <Video size={20} className="ico-blue" />
              Vídeo
            </button>
          </>
        )}
        <button className="gloss tool" title="Ver perfil" onClick={() => openProfile(recipient.id, conn)}>
          <UserRound size={20} className="ico-purple" />
          Perfil
        </button>
        {ringing && (
          <span className="dm-ringing">
            <Phone size={14} /> {recipient.displayName} está numa chamada com você.
          </span>
        )}
      </div>
      {inCall && (
        <div className="dm-call">
          <VoiceView channel={channel} />
          {voice.peers.length === 0 && <div className="dm-calling">Chamando {recipient.displayName}…</div>}
        </div>
      )}
      <div className="dm-grid">
        <ChatView channel={channel} variant="dm" />
        <div className="dm-photos">
          <PhotoCard user={recipient} label={recipient.displayName} onClick={() => openProfile(recipient.id, conn)} />
          <PhotoCard user={me} label="Você" />
        </div>
      </div>
    </main>
  );
}
