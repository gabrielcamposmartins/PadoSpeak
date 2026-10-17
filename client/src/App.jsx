import { useEffect } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useStore, primaryConn, openFromUrl } from './store.js';
import { isPanel, isTauri } from './lib/env.js';
import { setWindowMode } from './lib/appWindow.js';
import { useUpdate, runAutoUpdate } from './lib/update.js';
import AuthPage from './components/AuthPage.jsx';
import BootScreen from './components/Loading.jsx';
import AdminPage from './components/Admin.jsx';
import HostPage from './components/HostPage.jsx';
import Shell from './components/Shell.jsx';
import Modals from './components/Modals.jsx';
import IncomingCalls from './components/IncomingCall.jsx';
import CallScreen from './components/CallScreen.jsx';
import { SoundSprite } from './components/SoundIcons.jsx';
import Avatar from './components/Avatar.jsx';
import { TitleBar } from './components/Aero.jsx';
import { FormattedText } from './components/Emotes.jsx';
import { DownloadsIndicator } from './components/Files.jsx';
import { useAcross, unreadTotal } from './components/conn.jsx';
import { setUnreadBadge } from './lib/badge.js';
import { hasShared, takeShared } from './lib/share.js';

/** Aviso que sobe no canto, como o "fulano acabou de entrar" do Messenger. */
function Toast({ toast }) {
  return (
    <div className={`toast window ${toast.kind}${toast.url ? ' clickable' : ''}`} role="status" key={toast.id}>
      <TitleBar title="PadoSpeak" onClose={useStore.getState().dismissToast} />
      <div
        className="toast-body"
        onClick={
          toast.url
            ? () => {
                useStore.getState().dismissToast();
                openFromUrl(toast.url);
              }
            : undefined
        }
      >
        {toast.user ? (
          <Avatar user={toast.user} base={toast.base} size={38} frame />
        ) : toast.kind === 'error' ? (
          <AlertTriangle size={22} className="toast-ico error" />
        ) : (
          <Info size={22} className="toast-ico" />
        )}
        <span className="toast-text">
          <FormattedText text={toast.text} />
        </span>
      </div>
    </div>
  );
}

/** O que a tela de carregamento diz: a atualização vem antes de tudo; depois, o passo da abertura. */
function useBootStatus() {
  const { stage, version, progress, total } = useUpdate();
  const bootText = useStore((s) => s.bootText);
  if (stage === 'checking') return { text: 'Procurando atualizações…' };
  if (stage === 'downloading') {
    const pct = progress == null ? null : Math.round(progress * 100);
    const size = total ? ` de ${Math.round(total / 1048576)} MB` : '';
    return { text: `Baixando a nova versão ${version}`, sub: pct == null ? 'Baixando…' : `${pct}%${size}`, progress: progress ?? 0 };
  }
  if (stage === 'installing' || stage === 'ready') return { text: 'Instalando a nova versão…', sub: 'O PadoSpeak reabre sozinho' };
  return { text: bootText || (isTauri ? 'Iniciando…' : 'Conectando…') };
}

/** Contador de não lidas no ícone do app (barra de tarefas do Windows ou tela inicial do celular). */
function UnreadBadge() {
  const unread = useAcross(unreadTotal);
  useEffect(() => {
    setUnreadBadge(unread);
  }, [unread]);
  return null;
}

/** Veio do "Compartilhar" do celular: pergunta para qual conversa mandar (depois de entrar). */
function SharedInbox() {
  useEffect(() => {
    if (!hasShared()) return;
    history.replaceState(null, '', '/');
    takeShared()
      .then((shared) => {
        if (!shared) return;
        useStore.setState({ sharePending: { ...shared, target: null } });
        useStore.getState().openModal({ type: 'share' });
      })
      .catch(() => {});
  }, []);
  return null;
}

export default function App() {
  const phase = useStore((s) => s.phase);
  const toast = useStore((s) => s.toast);
  // Meu perfil (o local no app desktop): enquanto ele existir, a tela principal fica montada.
  const loggedIn = useAcross(() => Boolean(primaryConn().getState().me));

  const boot = useBootStatus();
  // Baixando ou instalando uma versão nova: só a tela de carregamento (o app reabre em seguida).
  const updating = ['downloading', 'installing', 'ready'].includes(useUpdate((s) => s.stage));
  const loading = phase === 'boot' || updating;

  useEffect(() => {
    // O app só abre depois de saber se há versão nova (até 3 s); havendo, instala e reabre antes.
    runAutoUpdate().then((updated) => updated || useStore.getState().boot());
  }, []);

  // App do Windows: a janela é só o cartão enquanto ninguém entrou; depois, a janela grande.
  const compact = loading || phase === 'auth';
  useEffect(() => {
    if (!isPanel) setWindowMode(compact ? 'compact' : 'full');
  }, [compact]);

  return (
    <>
      {loading && <BootScreen {...boot} />}
      {phase === 'auth' && !updating && <AuthPage />}
      {phase === 'host' && (isPanel || loggedIn) && <HostPage />}
      {phase === 'admin' && loggedIn && <AdminPage />}
      {/* O app continua montado na página Hostear para não derrubar uma chamada de voz em andamento. */}
      {loggedIn && !isPanel && (
        <div style={{ display: phase === 'app' && !updating ? 'contents' : 'none' }}>
          <Shell />
        </div>
      )}
      <SoundSprite />
      {loggedIn && !isPanel && <CallScreen />}
      <Modals />
      {loggedIn && <IncomingCalls />}
      {loggedIn && <UnreadBadge />}
      <DownloadsIndicator />
      {loggedIn && phase === 'app' && <SharedInbox />}
      {toast && <Toast key={toast.id} toast={toast} />}
    </>
  );
}
