import { useEffect, useRef } from 'react';
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
import { useLayout } from './lib/layout.js';
import { hasShared, takeShared } from './lib/share.js';

/** Celular: arrastar o aviso para a direita o dispensa (soltando antes do ponto, ele volta). */
function useSwipeAway(ref, onDismiss) {
  const drag = useRef(null); // { x, y, dx, on }
  const swiped = useRef(false); // o toque que arrastou não conta como clique
  const settle = (el, transform, opacity) => {
    el.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
    el.style.transform = transform;
    el.style.opacity = opacity;
  };
  const handlers = {
    onTouchStart: (e) => {
      const t = e.touches[0];
      swiped.current = false;
      drag.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, dx: 0, on: false } : null;
    },
    onTouchMove: (e) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;
      const t = e.touches[0];
      const dx = t.clientX - d.x;
      const dy = t.clientY - d.y;
      if (!d.on) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) return (drag.current = null);
        if (dx < 8) return;
        d.on = true;
        swiped.current = true;
        el.style.transition = 'none';
      }
      d.dx = Math.max(0, dx - 8);
      el.style.transform = `translateX(${d.dx}px)`;
      el.style.opacity = String(Math.max(0.15, 1 - d.dx / el.offsetWidth));
    },
    onTouchEnd: () => {
      const d = drag.current;
      const el = ref.current;
      drag.current = null;
      if (!d?.on || !el) return;
      if (d.dx > Math.min(110, el.offsetWidth * 0.3)) {
        settle(el, `translateX(${el.offsetWidth + 24}px)`, '0');
        setTimeout(onDismiss, 180);
      } else settle(el, '', '');
    },
  };
  handlers.onTouchCancel = handlers.onTouchEnd;
  return { handlers, swiped };
}

/** Aviso que sobe no canto, como o "fulano acabou de entrar" do Messenger. */
function Toast({ toast }) {
  const ref = useRef(null);
  const phone = useLayout() === 'phone';
  const { handlers, swiped } = useSwipeAway(ref, useStore.getState().dismissToast);
  return (
    <div
      ref={ref}
      className={`toast window ${toast.kind}${toast.url ? ' clickable' : ''}`}
      role="status"
      key={toast.id}
      {...(phone ? handlers : {})}
    >
      <TitleBar title="PadoSpeak" onClose={useStore.getState().dismissToast} />
      <div
        className="toast-body"
        onClick={
          toast.url
            ? () => {
                if (swiped.current) return;
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
