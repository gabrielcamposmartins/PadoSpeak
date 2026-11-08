// Efeitos da chamada (gestos da câmera): os emojis que sobem no vídeo de quem fez o gesto, guardados fora do
// estado do app (só os vídeos que mostram efeitos redesenham), e os de tela toda (`magic.js`).
import { useSyncExternalStore } from 'react';
import { playMagic } from './magic.js';

/** Efeito → emoji no vídeo. */
export const FX_EMOJI = { thumbs_up: '👍', thumbs_down: '👎', wave: '👋', confetti: '✌️', hearts: '🤟', stars: '⭐' };
/** Efeitos que também tomam a tela toda. */
export const FX_SCREEN = { confetti: 'confetti', hearts: 'hearts', stars: 'stars' };
/** Gesto reconhecido → efeito (o ☝️ levanta a mão, veja `store.js`). */
export const GESTURE_FX = { Thumb_Up: 'thumbs_up', Thumb_Down: 'thumbs_down', wave: 'wave', Victory: 'confetti', ILoveYou: 'hearts' };
const LIFE_MS = 2600;
const MAX_PER_USER = 3;

let items = []; // { id, userId, kind, at }
let seq = 0;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

/** Mostra um efeito de `userId` (`screen`: também o de tela toda). */
export function showFx({ userId, kind, screen = true }) {
  if (!FX_EMOJI[kind]) return;
  const now = Date.now();
  const live = items.filter((i) => now - i.at < LIFE_MS);
  const mine = live.filter((i) => i.userId === userId).slice(-(MAX_PER_USER - 1));
  items = [...live.filter((i) => i.userId !== userId), ...mine, { id: ++seq, userId, kind, at: now }];
  emit();
  setTimeout(() => {
    const before = items.length;
    items = items.filter((i) => Date.now() - i.at < LIFE_MS);
    if (items.length !== before) emit();
  }, LIFE_MS + 50);
  if (screen && FX_SCREEN[kind]) playMagic(FX_SCREEN[kind]);
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => items;

/** Os efeitos em andamento de uma pessoa (para desenhar no vídeo dela). */
export function useUserFx(userId) {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return userId ? all.filter((i) => i.userId === userId) : [];
}

/** Efeitos de quem não tem vídeo na tela agora (aparecem num canto, com o nome). */
export function useAllFx() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Vídeos na tela agora (por pessoa): o efeito de quem não tem vídeo visível aparece num canto. */
const mounted = new Map();
export function mountTile(userId) {
  if (!userId) return () => {};
  mounted.set(userId, (mounted.get(userId) || 0) + 1);
  emit();
  return () => {
    const n = (mounted.get(userId) || 1) - 1;
    if (n) mounted.set(userId, n);
    else mounted.delete(userId);
    emit();
  };
}
export const hasTile = (userId) => mounted.has(userId);
