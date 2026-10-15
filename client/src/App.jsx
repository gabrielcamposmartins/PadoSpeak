import { useEffect } from 'react';
import { AlertTriangle, Info, Download } from 'lucide-react';
import { useStore, primaryConn, openFromUrl } from './store.js';
import { isPanel } from './lib/env.js';
import { useUpdate, runAutoUpdate } from './lib/update.js';
import AuthPage from './components/AuthPage.jsx';
import AdminPage from './components/Admin.jsx';
import HostPage from './components/HostPage.jsx';
import Shell from './components/Shell.jsx';
import Modals from './components/Modals.jsx';
import IncomingCalls from './components/IncomingCall.jsx';
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

/** Progresso da atualização automática (só aparece quando há versão nova). */
function UpdateOverlay() {
  const { stage, version, progress } = useUpdate();
  if (stage !== 'downloading' && stage !== 'installing' && stage !== 'ready') return null;
  return (
    <div className="update-window window" role="status" aria-live="polite">
      <TitleBar title="Atualizando o PadoSpeak" />
      <div className="update-body">
        <Download size={22} className="toast-ico" />
        <div>
          <b>Versão {version}</b>
          <span>
            {stage === 'downloading'
              ? progress == null
                ? 'Baixando…'
                : `Baixando… ${Math.round(progress * 100)}%`
              : 'Instalando — o app reabre sozinho.'}
          </span>
          <div className="np-progress">
            <div style={{ width: `${Math.round((progress ?? 0.3) * 100)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
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

  useEffect(() => {
    useStore.getState().boot();
    runAutoUpdate();
  }, []);

  return (
    <>
      {phase === 'boot' && <div className="boot">Conectando…</div>}
      {phase === 'auth' && <AuthPage />}
      {phase === 'host' && (isPanel || loggedIn) && <HostPage />}
      {phase === 'admin' && loggedIn && <AdminPage />}
      {/* O app continua montado na página Hostear para não derrubar uma chamada de voz em andamento. */}
      {loggedIn && !isPanel && (
        <div style={{ display: phase === 'app' ? 'contents' : 'none' }}>
          <Shell />
        </div>
      )}
      <Modals />
      {loggedIn && <IncomingCalls />}
      {loggedIn && <UnreadBadge />}
      <DownloadsIndicator />
      {loggedIn && phase === 'app' && <SharedInbox />}
      {toast && <Toast key={toast.id} toast={toast} />}
      <UpdateOverlay />
    </>
  );
}
