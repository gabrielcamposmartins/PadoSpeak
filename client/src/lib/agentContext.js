/**
 * Assistente: o que está na tela quando a pessoa pede alguma coisa. O assistente abre num balão por cima da
 * tela (Agent.jsx), e cada pedido leva isto junto (`POST /api/agent/messages`): o servidor e o canal (ou a
 * conversa) abertos e, numa chamada, os dados técnicos dela medidos aqui (a ferramenta `call_quality` do
 * servidor lê).
 *
 * O servidor confere tudo com o login da pessoa (um canal que ela não vê não traz nada) e completa o resto:
 * os canais do servidor, quem está em cada canal de voz e a chamada em que ela está.
 */
import { useStore, activeVoiceConn } from '../store.js';
import { plain } from './text.js';

/** O que a pessoa está vendo: text, voice, dm, friends, call ou home. */
export function pageKind(s) {
  const t = s.view?.type;
  if (['text', 'voice', 'dm', 'friends', 'call'].includes(t)) return t;
  return 'home';
}

/** A tela de agora, só com o que é deste servidor (a conversa aberta de outra conexão não vai). */
function place(s) {
  const mine = s.view?.conn == null;
  return {
    guildId: mine ? s.currentGuildId || null : null,
    channelId: mine && ['text', 'voice', 'dm', 'call'].includes(s.view?.type) ? s.view.channelId || null : null,
  };
}

/** O contexto de um pedido ao assistente. */
export function requestContext() {
  const s = useStore.getState();
  const now = new Date();
  const call = activeVoiceConn();
  let callQuality = null;
  try {
    callQuality = call.getState().voice ? call.getState().callQuality?.() || null : null;
  } catch {
    callQuality = null;
  }
  return {
    localTime: now.toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' }),
    tzOffset: -now.getTimezoneOffset(),
    ...place(s),
    page: { kind: pageKind(s) },
    callQuality,
  };
}

/**
 * O que o balão mostra como "vendo agora" (o mesmo que vai no pedido, em palavras): o servidor, o canal ou a
 * conversa e a chamada. Uma string, para o seletor do store não refazer a lista a cada mudança.
 */
export function scopeLabel(s) {
  const parts = [];
  const { guildId, channelId } = place(s);
  const guild = guildId && s.guilds?.find((g) => g.id === guildId);
  const kind = pageKind(s);
  if (kind === 'dm') {
    const dm = s.dms?.find((d) => d.id === channelId);
    parts.push(dm?.recipient ? `Conversa com ${plain(dm.recipient.displayName)}` : 'Conversa privada');
  } else if (kind === 'call') parts.push('Chamada');
  else if (channelId && guild) {
    const ch = s.guildData?.[guildId]?.channels?.find((c) => c.id === channelId);
    if (ch) {
      const people = kind === 'voice' ? (s.voiceStates?.[channelId] || []).length : 0;
      parts.push(kind === 'voice' ? `🔊 ${ch.name}${people ? ` (${people} na chamada)` : ''}` : `#${ch.name}`);
    }
  } else if (!guild) parts.push('Início');
  if (guild) parts.push(guild.name);
  const call = s.voice;
  if (call?.channelId && call.channelId !== channelId) parts.push('na chamada');
  return parts.join(' · ');
}
