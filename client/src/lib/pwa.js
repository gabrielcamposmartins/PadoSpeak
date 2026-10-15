// PadoSpeak como app instalado (PWA): service worker, convite para instalar (botão no Android e no
// computador, passo a passo no iPhone e no iPad), notificações push e número no ícone.
import { useSyncExternalStore } from 'react';
import { isTauri, isPanel, isDesktop } from './env.js';
import { isStandalone } from './layout.js';
import { storage } from './api.js';

/** Só no navegador servido pelo servidor de comunidade (o app desktop tem as próprias notificações). */
export const pwaCapable =
  typeof window !== 'undefined' &&
  !isTauri &&
  !isPanel &&
  !isDesktop &&
  'serviceWorker' in navigator &&
  window.isSecureContext;

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
// O iPad se apresenta como Mac no Safari; o que entrega é ter tela de toque.
const ipad = /iPad/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ios = ipad || /iPhone|iPod/.test(ua);

let deferredPrompt = null; // evento beforeinstallprompt (Chrome/Edge/Android)
let installed = isStandalone;
let pushOn = false;
let version = 0;
const listeners = new Set();
const emit = () => {
  version += 1;
  listeners.forEach((f) => f());
};
const subscribe = (f) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
/** Re-renderiza quando o estado de instalação ou de push muda. */
export const usePwa = () => useSyncExternalStore(subscribe, () => version, () => 0);

const DISMISS_KEY = 'padospeak.installDismissed';
const dismissedRecently = () => Date.now() - Number(storage.get(DISMISS_KEY) || 0) < 14 * 86400000;

/**
 * Como oferecer a instalação: 'prompt' (botão Instalar), 'ios' / 'ipad' (passo a passo do Safari)
 * ou null (já instalado, dispensado há pouco ou não dá para instalar).
 */
export function installMode({ ignoreDismiss = false } = {}) {
  if (!pwaCapable || installed) return null;
  if (!ignoreDismiss && dismissedRecently()) return null;
  if (deferredPrompt) return 'prompt';
  if (ios) return ipad ? 'ipad' : 'ios';
  return null;
}

/**
 * Para a aba "Apps" das configurações (que mostra o botão em qualquer lugar): 'installed', 'prompt'
 * (o navegador abre o pedido de instalar), 'ios' / 'ipad', 'desktop' (app do Windows: instala pelo
 * navegador) ou 'manual' (pelo menu do navegador; `browser` diz qual).
 */
export function installState() {
  if (isTauri || isDesktop) return { mode: 'desktop' };
  if (installed) return { mode: 'installed' };
  if (pwaCapable && deferredPrompt) return { mode: 'prompt' };
  if (ios) return { mode: ipad ? 'ipad' : 'ios' };
  const browser = /Firefox\//.test(ua)
    ? 'firefox'
    : /Android/.test(ua)
      ? 'android'
      : /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg/.test(ua)
        ? 'safari'
        : 'chromium';
  return { mode: 'manual', browser, secure: typeof window !== 'undefined' && window.isSecureContext };
}

export function dismissInstall() {
  storage.set(DISMISS_KEY, String(Date.now()));
  emit();
}

export async function install() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
  deferredPrompt = null;
  if (outcome === 'accepted') installed = true;
  emit();
}

/**
 * Push: 'on', 'off', 'denied' ou 'unsupported'. No iPhone/iPad só existe com o app instalado na tela
 * de início (iOS 16.4+); no Safari comum o iOS não oferece.
 */
export function pushStatus() {
  if (!pwaCapable || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return pushOn ? 'on' : 'off';
}

const keyBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** Ativa as notificações deste aparelho (precisa vir de um toque: exigência do iOS). */
export async function enablePush(store) {
  if (pushStatus() === 'unsupported') throw new Error('Este navegador não recebe notificações do PadoSpeak.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    emit();
    throw new Error('As notificações foram bloqueadas. Libere nas configurações do aparelho para o PadoSpeak.');
  }
  const publicKey = await store.getState().pushKey();
  if (!publicKey) throw new Error('Este servidor não envia notificações.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await store.getState().pushSubscribe(sub.toJSON());
  pushOn = true;
  emit();
}

/** Desliga as notificações deste aparelho (também ao sair da conta). */
export async function disablePush(store) {
  if (!pwaCapable) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) {
    await store.getState().pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  pushOn = false;
  emit();
}

/** Ao entrar: se este aparelho já recebia notificações, confirma a inscrição no servidor. */
export async function syncPush(store) {
  if (pushStatus() === 'unsupported' || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    pushOn = Boolean(sub);
    if (sub) await store.getState().pushSubscribe(sub.toJSON());
  } catch {
    pushOn = false;
  }
  emit();
}

/** Número de conversas não lidas no ícone do app (Android, iPhone e iPad com o app instalado). */
export function setBadge(count) {
  if (!pwaCapable || !('setAppBadge' in navigator)) return;
  (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

/** Liga o service worker e os eventos de instalação. `onOpen(url)`: toque numa notificação. */
export function initPwa({ onOpen } = {}) {
  if (!pwaCapable) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installed = true;
    emit();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open') onOpen?.(e.data.url);
  });
  // Voltou para o app: as notificações já vistas saem da central.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    navigator.serviceWorker.getRegistration().then((reg) =>
      reg?.getNotifications?.().then((list) => list.forEach((n) => n.close())),
    );
  });
}
