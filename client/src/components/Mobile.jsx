// Celular: uma tela por vez. Abas embaixo (Conversas, Amigos, Servidores, Eu); conversa, canal, chamada
// e música abrem em tela cheia com "voltar". Também o convite para instalar e as notificações push.
import { useEffect } from 'react';
import {
  MessageCircle,
  Users,
  LayoutGrid,
  UserRound,
  ChevronLeft,
  Settings,
  Pencil,
  LogOut,
  Bell,
  BellOff,
  Download,
  Share,
  SquarePlus,
  X,
  CircleAlert,
  ChartColumn,
} from 'lucide-react';
import { useStore, primaryConn, localLogout } from '../store.js';
import { isDesktop } from '../lib/env.js';
import { useAcross } from './conn.jsx';
import Avatar from './Avatar.jsx';
import { FormattedText } from './Emotes.jsx';
import { useAppBackground, ProfileBar, GuildRail, ChannelSidebar, Main, VoiceStatus, StatusMenu } from './Shell.jsx';
import { HomeSidebar, FriendsPage, FriendTabs } from './Home.jsx';
import MusicPanel from './MusicPanel.jsx';
import { colorClass, colorStyle, STATUS_INFO } from './Avatar.jsx';
import {
  usePwa,
  installMode,
  install,
  dismissInstall,
  pushStatus,
  enablePush,
  disablePush,
  setBadge,
} from '../lib/pwa.js';

/** "Voltar" da tela cheia (só aparece no celular). */
export function MobileBack({ label = 'Voltar' }) {
  return (
    <button className="gloss m-back" onClick={() => useStore.getState().mobileBack()} title={label} aria-label={label}>
      <ChevronLeft size={20} />
    </button>
  );
}

const unreadTotal = (states) => states.reduce((n, st) => n + Object.values(st.unread).reduce((a, b) => a + b, 0), 0);

function TabBar() {
  const tab = useStore((s) => s.mobileTab);
  const unread = useAcross(unreadTotal);
  const pending = useStore((s) => Object.values(s.friends).filter((f) => f.status === 'incoming').length);
  const tabs = [
    ['chats', 'Conversas', MessageCircle, unread],
    ['friends', 'Amigos', Users, pending],
    ['servers', 'Servidores', LayoutGrid, 0],
    ['me', 'Eu', UserRound, 0],
  ];
  return (
    <nav className="m-tabs" aria-label="Navegação">
      {tabs.map(([id, label, Icon, badge]) => (
        <button
          key={id}
          className={`m-tab${tab === id ? ' on' : ''}`}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => useStore.getState().setMobileTab(id)}
        >
          <Icon size={22} />
          <span>{label}</span>
          {badge > 0 && <span className="badge m-badge">{badge > 99 ? '99+' : badge}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Convite para instalar: botão (Android/computador) ou o passo a passo do Safari (iPhone/iPad). */
export function InstallCard({ always = false }) {
  usePwa();
  const mode = installMode({ ignoreDismiss: always });
  if (!mode) return null;
  return (
    <div className={`install-card glass${mode !== 'prompt' ? ` ios-${mode}` : ''}`} role="note">
      <img src="/icons/icon-192.png" alt="" width="40" height="40" />
      <div className="install-text">
        <b>Instalar o PadoSpeak</b>
        {mode === 'prompt' ? (
          <span>Abre direto da tela inicial, em tela cheia, e avisa quando chegar mensagem.</span>
        ) : (
          <span>
            Toque em <Share size={14} aria-label="Compartilhar" /> Compartilhar
            {mode === 'ipad' ? ' (no alto, à direita)' : ' (embaixo)'} e depois em{' '}
            <SquarePlus size={14} aria-hidden="true" /> “Adicionar à Tela de Início”.
          </span>
        )}
      </div>
      {mode === 'prompt' && (
        <button className="go" onClick={install}>
          <Download size={15} /> Instalar
        </button>
      )}
      {!always && (
        <button className="gloss mini" title="Agora não" aria-label="Agora não" onClick={dismissInstall}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Ativar/desativar as notificações deste aparelho (o pedido precisa vir de um toque). */
export function PushCard({ compact = false }) {
  usePwa();
  const status = pushStatus();
  if (status === 'unsupported' || (compact && status !== 'off')) return null;
  const toggle = async () => {
    try {
      if (status === 'on') await disablePush(primaryConn());
      else await enablePush(primaryConn());
    } catch (e) {
      useStore.getState().notify(e.message);
    }
  };
  if (compact)
    return (
      <div className="push-card glass" role="note">
        <Bell size={18} className="ico-gold" />
        <div className="install-text">
          <b>Receber avisos com o PadoSpeak fechado?</b>
          <span>Mensagens, chamadas e “chamar atenção” aparecem como notificação do aparelho.</span>
        </div>
        <button className="go" onClick={toggle}>
          Ativar
        </button>
      </div>
    );
  return (
    <button className="m-row" onClick={toggle} disabled={status === 'denied'}>
      {status === 'on' ? <Bell size={20} className="ico-gold" /> : <BellOff size={20} />}
      <span>
        <b>Notificações {status === 'on' ? 'ligadas' : 'desligadas'}</b>
        <small>
          {status === 'denied'
            ? 'Bloqueadas no aparelho: libere nas configurações para o PadoSpeak.'
            : status === 'on'
              ? 'Toque para desligar neste aparelho.'
              : 'Toque para receber avisos com o app fechado.'}
        </small>
      </span>
    </button>
  );
}

/** Aba "Eu": perfil, status, configurações, notificações, instalar e sair. */
function MePage() {
  const prim = primaryConn();
  const me = prim((s) => s.me);
  const base = prim((s) => s.baseUrl);
  const myStatus = prim((s) => s.myStatus);
  const adminAccess = useStore((s) => Boolean(s.appAdmin?.canView));
  if (!me) return null;
  const { openModal, logout } = useStore.getState();
  const info = STATUS_INFO[myStatus] || STATUS_INFO.online;
  return (
    <div className="m-me">
      <div className="m-me-card glass">
        <Avatar user={me} base={base} size={72} status={info.cls} onClick={() => openModal({ type: 'editProfile' })} />
        <div className="m-me-text">
          <b className={colorClass(me.nameColor)} style={colorStyle(me.nameColor)}>
            <FormattedText text={me.displayName} size={18} />
          </b>
          <span className="m-user">@{me.username}</span>
          <StatusMenu status={info.cls} label={myStatus === 'invisible' ? 'Offline (invisível)' : info.label} />
          {me.bio && (
            <span className={colorClass(me.bioColor, 'm-bio')} style={colorStyle(me.bioColor)}>
              <FormattedText text={me.bio} />
            </span>
          )}
        </div>
      </div>
      <InstallCard always />
      <div className="m-list glass">
        <button className="m-row" onClick={() => openModal({ type: 'editProfile' })}>
          <Pencil size={20} className="ico-purple" />
          <span>
            <b>Editar perfil</b>
            <small>Foto, nome, mensagem pessoal e cores</small>
          </span>
        </button>
        <PushCard />
        <button className="m-row" onClick={() => openModal({ type: 'settings' })}>
          <Settings size={20} className="ico-blue" />
          <span>
            <b>Configurações</b>
            <small>Tema, microfone, câmera e sons</small>
          </span>
        </button>
        {adminAccess && (
          <button className="m-row" onClick={() => useStore.getState().goAdmin()}>
            <ChartColumn size={20} className="ico-blue" />
            <span>
              <b>Painel do administrador</b>
              <small>Pessoas, servidores e horários de uso</small>
            </span>
          </button>
        )}
        <button className="m-row" onClick={() => openModal({ type: 'changelog' })}>
          <CircleAlert size={20} className="ico-gold" />
          <span>
            <b>Notas de atualização</b>
            <small>O que mudou em cada versão</small>
          </span>
        </button>
        <button
          className="m-row danger"
          onClick={async () => {
            await disablePush(prim).catch(() => {});
            if (isDesktop) localLogout();
            else logout();
          }}
        >
          <LogOut size={20} />
          <span>
            <b>Sair da conta</b>
          </span>
        </button>
      </div>
    </div>
  );
}

function ServersPane() {
  const guild = useStore((s) => s.guilds.find((g) => g.id === s.currentGuildId));
  const hasGuilds = useStore((s) => s.guilds.length > 0);
  return (
    <div className="m-servers">
      <GuildRail />
      {guild ? (
        <ChannelSidebar />
      ) : (
        <aside className="sidebar glass m-empty">
          <p>{hasGuilds ? 'Escolha um servidor à esquerda.' : 'Você ainda não está em nenhum servidor. Toque no + para criar um ou entrar com um convite.'}</p>
        </aside>
      )}
    </div>
  );
}

export default function MobileShell() {
  const tab = useStore((s) => s.mobileTab);
  const pane = useStore((s) => s.mobilePane);
  const view = useStore((s) => s.view);
  const music = useStore((s) => s.sidebarView === 'music' && s.currentGuildId != null);
  const unread = useAcross(unreadTotal);
  useEffect(() => setBadge(unread), [unread]);

  const detail = pane === 'detail' && (music || ['dm', 'text', 'voice'].includes(view?.type));
  const bg = useAppBackground();
  return (
    <div className={`aero-app mobile-app${detail ? ' m-open' : ''}`} {...bg}>
      {!detail && <ProfileBar />}
      <div className="m-body">
        {detail ? (
          music ? (
            <aside className="sidebar glass music-side m-music">
              <MusicPanel />
            </aside>
          ) : (
            <Main />
          )
        ) : tab === 'chats' ? (
          <aside className="sidebar glass m-chats" aria-label="Conversas">
            <InstallCard />
            <PushCard compact />
            <HomeSidebar />
          </aside>
        ) : tab === 'friends' ? (
          <div className="m-friends">
            <FriendTabs />
            <FriendsPage />
          </div>
        ) : tab === 'servers' ? (
          <ServersPane />
        ) : (
          <MePage />
        )}
      </div>
      {!detail && <VoiceStatus />}
      {!detail && <TabBar />}
    </div>
  );
}
