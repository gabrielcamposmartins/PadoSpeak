import { create } from 'zustand';
import { createApi, loadToken, saveToken, savedServerUrl, saveServerUrl, normalizeUrl, ApiError, storage } from './lib/api.js';
import { Realtime } from './lib/realtime.js';
import { VoiceClient } from './lib/voice.js';
import { MusicPlayer } from './lib/music.js';
import { isPanel, isDesktop, localNodeUrl } from './lib/env.js';
import { playSound, loopSound, setSoundsEnabled } from './lib/sounds.js';
import { shakeWindow, flashTaskbar } from './lib/attention.js';
import { systemNotify, showAppWindow } from './lib/background.js';
import { currentLayout } from './lib/layout.js';
import { syncPush, disablePush } from './lib/pwa.js';

/*
 * Conexões
 * --------
 * O app fala com até três tipos de servidor ao mesmo tempo, todos com a mesma lógica (`createConnStore`):
 *
 * - `server` (useStore): o servidor de comunidade — guilds, amigos, DMs e canais de voz. No navegador é
 *   o próprio servidor que serviu a página; no app desktop é padospeak.padoru.org (ou o escolhido em Hostear).
 *   Este store também guarda o estado da interface (janelas, avisos, preferências, tela aberta).
 * - `local` (só desktop): o nó local embutido no app, com o perfil deste PC — o login funciona offline.
 * - `peer:<endereço>` (só desktop): o nó local de outro PC da rede, onde ficam as conversas em que o
 *   outro perfil é o "dono" (o de menor id). Entramos lá como convidados.
 */

/** Último aviso de "ficou online" por pessoa (para quem desligou as notificações repetidas). */
const lastOnlineAlert = new Map();
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
/** Tempo tocando sem resposta antes de desistir da chamada 1 a 1. */
const CALL_TIMEOUT_MS = 45000;
/** Nova tentativa de falar com o servidor de comunidade quando ele está fora do ar. */
const SERVER_RETRY_MS = 60000;

/** Traduz os erros de getUserMedia da câmera para algo acionável. */
function cameraError(e) {
  if (e.name === 'NotReadableError' || e.name === 'TrackStartError' || e.name === 'AbortError')
    return 'A câmera está em uso por outro programa (ou outra janela do PadoSpeak). No Windows, uma webcam só pode ser usada por um programa por vez.';
  if (e.name === 'NotAllowedError') return 'Permissão para usar a câmera foi negada.';
  if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return 'Nenhuma câmera encontrada.';
  return `Câmera: ${e.message}`;
}

const INSECURE_MSG =
  'Câmera e compartilhamento de tela exigem HTTPS no navegador. Peça ao host para ativar HTTPS ou use o app PadoSpeak.';

const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem('padospeak.prefs')) || {};
  } catch {
    return {};
  }
};
const savePrefs = (p) => {
  try {
    localStorage.setItem('padospeak.prefs', JSON.stringify(p));
  } catch {
    /* ignora */
  }
};

/** Sons a partir da diferença entre dois estados da chamada (no máximo um por mudança). */
function voiceSounds(prev, next, notify) {
  if (!prev?.channelId && next?.channelId) return playSound('join');
  if (prev?.channelId && !next?.channelId) return playSound('leave');
  if (!prev || !next || prev.channelId !== next.channelId) return;
  const before = new Map(prev.peers.map((p) => [p.peerId, p]));
  const after = new Map(next.peers.map((p) => [p.peerId, p]));
  if ([...after.keys()].some((id) => !before.has(id))) return playSound('join');
  if ([...before.keys()].some((id) => !after.has(id))) return playSound('leave');
  const streamer = next.peers.find((p) => p.screenAnnounced && before.get(p.peerId)?.screenAnnounced === false);
  if (streamer) notify(`${streamer.user.displayName} começou a transmitir.`, 'presence', streamer.user);
  if ((!prev.screen && next.screen) || streamer) return playSound('streamStart');
  const stopped =
    (prev.screen && !next.screen) ||
    next.peers.some((p) => !p.screenAnnounced && before.get(p.peerId)?.screenAnnounced);
  if (stopped) playSound('streamStop');
}

/** Mensagem que é só um sticker: `[sticker:<id>]` (da coleção) ou `[sticker:emote:<código>]` (padrão). */
export const STICKER_RE = /^\[sticker:(emote:)?([^\]\s]+)\]$/;

/** Todas as conexões abertas (chave → store). A lista de chaves vive em `useStore.connKeys`. */
export const connRegistry = new Map();
const syncConnKeys = () => useStore?.setState({ connKeys: [...connRegistry.keys()] });

/**
 * Perfil local que está usando o app desktop. A sessão do servidor de comunidade é guardada por perfil:
 * ao trocar de perfil no mesmo PC, o servidor não continua logado na conta do anterior.
 */
let profileScope = null;
const tokenScope = (kind) => (isDesktop && kind === 'server' ? profileScope : null);

/** Store de uma conexão. `primary`: o store principal (`server`), que também guarda a interface. */
export function createConnStore({ key, kind, base, primary = false }) {
  let rt = null;
  let voiceClient = null;
  const typingTimers = new Map();
  let baseUrl = base;
  // No desktop, o servidor só tem token depois que um perfil local entra (veja `reloadToken`).
  let token = isDesktop && kind === 'server' ? null : loadToken(baseUrl, tokenScope(kind));
  const api = createApi(
    () => baseUrl,
    () => token,
  );
  const setToken = (t) => {
    token = t;
    saveToken(baseUrl, t, tokenScope(kind));
  };
  let store = null;
  /** Store da interface (este mesmo, se for o principal). */
  const ui = () => (primary ? store : useStore);
  const prefs = () => ui().getState().prefs;
  const notify = (text, kind2, user) => ui().getState().notify(text, kind2, user, baseUrl);
  /** A tela aberta é da interface; nos stores secundários ela leva a chave da conexão. */
  const setView = (patch) => {
    if (primary) return store.setState(patch);
    useStore.setState({ ...patch, view: patch.view ? { ...patch.view, conn: key } : patch.view });
  };
  /** Celular: abre a tela cheia (conversa, canal, chamada ou música) por cima da lista. */
  const openPane = () => ui().setState({ mobilePane: 'detail' });
  const isViewing = (channelId) => {
    const v = ui().getState().view;
    return v?.channelId === channelId && (v.conn || 'server') === key;
  };

  store = create((set, get) => ({
    key,
    kind, // server | local | peer
    baseUrl,
    phase: isPanel ? 'host' : 'boot', // boot | auth | app | host (só no principal)
    serverUrl: baseUrl,
    /** Situação do servidor de comunidade no app desktop: off | connecting | online | unreachable | login | mismatch */
    serverStatus: 'off',
    connKeys: [],
    me: null,
    config: null,
    rtStatus: 'connecting',

    guilds: [],
    guildData: {}, // id -> { channels, members }
    currentGuildId: null,
    view: null, // { type: 'text' | 'voice' | 'dm' | 'friends', channelId, conn? }
    lastChannel: {},

    messages: {}, // channelId -> Message[]
    hasMore: {},
    online: {},
    statuses: {}, // userId -> online | away | busy (de quem está visível)
    myStatus: 'online', // online | away | busy | invisible
    nudgeSettings: null, // { allowNudges, nudgeBlocks: User[] }
    voiceStates: {}, // channelId -> participantes (visão do servidor)
    typing: {}, // channelId -> { userId: { user, until } }
    lanPeers: [], // perfis da rede local (só no nó local)
    stickers: null, // minha coleção de stickers neste servidor (null = ainda não carregada)

    voice: null, // snapshot do VoiceClient
    selfMuted: false,
    selfDeafened: false,
    prefs: loadPrefs(),

    showMembers: true,
    // Celular: aba de baixo e se a tela mostra a lista ou o que foi aberto (conversa, canal, chamada).
    mobileTab: 'chats', // chats | friends | servers | me
    mobilePane: 'list', // list | detail
    membersOpen: false, // celular/tablet: lista de membros por cima da conversa
    users: {}, // atualizações de perfil recebidas (id -> usuário)
    friends: {}, // userId -> { user, status: friend | incoming | outgoing }
    dms: [], // conversas diretas, mais recentes primeiro
    unread: {}, // dmId -> mensagens não lidas
    incomingCall: null, // { dmId, from }
    sidebarView: 'channels', // channels | music
    music: {}, // canal de voz -> estado da fila (music:state)
    serverOffset: 0, // relógio do servidor − relógio local (ms)
    musicAdding: 0,
    friendsTab: 'online', // online | all | pending | add
    modal: null,
    toast: null,

    // ---------- Interface (só faz sentido no principal) ----------
    openModal: (modal) => ui().setState({ modal }),
    closeModal: () => ui().setState({ modal: null }),
    /** Aviso no canto. `kind`: error | info | presence (com a foto de `user`, servida por `base`). */
    notify(text, kind2 = 'error', user = null, base = null) {
      if (!primary) return notify(text, kind2, user);
      const id = Date.now() + Math.random();
      set({ toast: { text, kind: kind2, user, base: base || baseUrl, id } });
      // App na bandeja ou minimizado: também avisa pelo Windows.
      if (kind2 === 'presence') systemNotify(text);
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 4500);
    },
    dismissToast: () => ui().setState({ toast: null }),
    setFriendsTab: (friendsTab) => ui().setState({ friendsTab }),
    /** Tema (system | light | dark) e cena do topo (0 Céu/Noite, 1 Aquário/Abismo, 2 Aurora). */
    setAppearance(patch) {
      const next = { ...prefs(), ...patch };
      ui().setState({ prefs: next });
      savePrefs(next);
    },
    goHost: () => ui().setState({ phase: 'host' }),
    leaveHost: () => ui().setState({ phase: 'app' }),

    // ---------- Sessão ----------
    /** Abertura do app (só no principal): no navegador entra no servidor; no desktop, no perfil local. */
    async boot() {
      if (isPanel) return;
      if (isDesktop) return bootDesktop();
      if (!token) return set({ phase: 'auth' });
      try {
        const me = await api.get('/api/me');
        await get().enterApp(me);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setToken(null);
        set({ phase: 'auth' });
      }
    },

    /** Troca o endereço desta conexão (o token salvo passa a ser o do endereço novo). */
    setBase(url) {
      baseUrl = normalizeUrl(url);
      token = loadToken(baseUrl, tokenScope(kind));
      set({ baseUrl, serverUrl: baseUrl });
    },

    /** O perfil local mudou: passa a usar a sessão salva desse perfil (ou nenhuma). */
    reloadToken() {
      token = loadToken(baseUrl, tokenScope(kind));
    },

    /** Entra (ou cria a conta) nesta conexão. */
    async authenticate(mode, form) {
      const res = await api.post(`/api/auth/${mode}`, form);
      setToken(res.token);
      await get().enterApp(res.user);
      return res.user;
    },

    /** Entra com um token já obtido (convidado num PC da rede). */
    async enterWithToken(t, me) {
      setToken(t);
      await get().enterApp(me);
    },

    async logout() {
      // Este aparelho para de receber notificações da conta que saiu.
      if (primary && !isDesktop) await disablePush(store).catch(() => {});
      await api.post('/api/auth/logout').catch(() => {});
      get().teardown();
      setToken(null);
      if (primary && !isDesktop) set({ phase: 'auth', me: null });
      else set({ me: null });
    },

    /** Fecha a conexão sem sair da conta (o token continua salvo). */
    teardown() {
      voiceClient?.leave();
      voiceClient = null;
      rt?.close();
      rt = null;
      set({
        me: null,
        guilds: [],
        guildData: {},
        messages: {},
        hasMore: {},
        online: {},
        statuses: {},
        voiceStates: {},
        music: {},
        typing: {},
        voice: null,
        users: {},
        friends: {},
        dms: [],
        unread: {},
        incomingCall: null,
        lanPeers: [],
        nudgeSettings: null,
      });
      if (primary) set({ currentGuildId: null, sidebarView: 'channels' });
      if (primary && (!get().view || get().view.conn == null) && get().view?.type !== 'dm') {
        if (get().view?.type !== 'friends') set({ view: isDesktop ? { type: 'friends' } : null });
      }
    },

    async enterApp(me) {
      const [config, guilds, friends, dms] = await Promise.all([
        api.get('/api/config'),
        api.get('/api/guilds'),
        api.get('/api/friends'),
        api.get('/api/dms'),
      ]);
      setSoundsEnabled(prefs().sounds !== false);
      set({
        me,
        config,
        guilds,
        dms,
        friends: Object.fromEntries(friends.map((f) => [f.user.id, f])),
        statuses: Object.fromEntries(friends.filter((f) => f.presence).map((f) => [f.user.id, f.presence])),
      });
      api
        .get('/api/me/settings')
        .then((nudgeSettings) => set({ nudgeSettings }))
        .catch(() => {});
      if (kind === 'local') {
        api
          .get('/api/lan/peers')
          .then((lanPeers) => set({ lanPeers }))
          .catch(() => {});
      }
      get().connectRealtime();
      if (!primary) return;
      if (kind === 'server' && isDesktop) {
        set({ serverStatus: 'online' });
        return;
      }
      set({ phase: 'app' });
      syncPush(store);
      // Link de convite aberto no navegador: /invite/<código>
      const invite = location.pathname.match(/^\/invite\/([\w-]+)/);
      if (invite) {
        history.replaceState(null, '', '/');
        try {
          return await get().joinGuild(invite[1]);
        } catch (e) {
          get().notify(e.message);
        }
      }
      if (guilds[0] && currentLayout() !== 'phone') get().selectGuild(guilds[0].id);
      else get().goHome();
      openFromUrl();
    },

    connectRealtime() {
      rt?.close();
      rt = new Realtime(() => `${baseUrl.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(token || '')}`);
      let firstReady = true;
      rt.on('status', (rtStatus) => set({ rtStatus }));
      rt.on('ready', () => {
        if (document.visibilityState !== 'visible') rt?.send('app:visibility', { visible: false });
      });
      rt.on('ready', (d) => {
        set({
          online: Object.fromEntries(d.online.map((id) => [id, true])),
          statuses: d.statuses || {},
          myStatus: d.selfStatus || 'online',
          voiceStates: d.voice || {},
          music: Object.fromEntries((d.music || []).map((m) => [m.channelId, m])),
          serverOffset: d.serverTime - Date.now(),
        });
        // O que mudou entre o carregamento inicial e a conexão (ou durante uma queda) não chegou por evento.
        if (!firstReady) get().resync();
        else {
          get().loadFriends();
          get().loadDms();
        }
        firstReady = false;
      });
      rt.on('retry', async () => {
        // Token revogado/expirado: pede login de novo em vez de tentar para sempre.
        try {
          await api.get('/api/me');
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) return;
          get().teardown();
          setToken(null);
          if (kind === 'server' && isDesktop) set({ serverStatus: 'login' });
          else if (kind === 'server') set({ phase: 'auth', me: null });
          else if (kind === 'local') useStore.setState({ phase: 'auth' });
        }
      });
      rt.on('lan:peers', (lanPeers) => kind === 'local' && set({ lanPeers }));
      rt.on('presence:update', ({ userId, online, status }) => {
        const s = get();
        const friend = s.friends[userId];
        // Ficou online (inclusive quem saiu do "aparecer offline"). Quem desligou as notificações
        // repetidas recebe no máximo um aviso por pessoa a cada 10 minutos.
        if (online && !s.online[userId] && friend?.status === 'friend' && userId !== s.me?.id) {
          const now = Date.now();
          const repeat = prefs().repeatAlerts !== false;
          if (repeat || now - (lastOnlineAlert.get(userId) || 0) > REPEAT_WINDOW_MS) {
            lastOnlineAlert.set(userId, now);
            const user = s.users[userId] || friend.user;
            notify(`${user.displayName} acabou de ficar online.`, 'presence', user);
            playSound('message');
          }
        }
        set((st) => {
          const statuses = { ...st.statuses };
          if (online) statuses[userId] = status || 'online';
          else delete statuses[userId];
          return { online: { ...st.online, [userId]: online || undefined }, statuses };
        });
      });
      rt.on('status:self', ({ status }) => set({ myStatus: status }));
      rt.on('nudge', ({ channelId, dm, from }) => {
        if (dm && !get().dms.some((d) => d.id === channelId)) get().loadDms();
        get().pushNotice(channelId, { kind: 'nudge-in', author: from });
        playSound('nudge');
        shakeWindow();
        flashTaskbar();
        notify(`${from.displayName} chamou a sua atenção!`, 'presence', from);
      });
      rt.on('user:updated', (u) =>
        set((s) => {
          const friends = s.friends[u.id] ? { ...s.friends, [u.id]: { ...s.friends[u.id], user: u } } : s.friends;
          return {
            users: { ...s.users, [u.id]: u },
            me: s.me?.id === u.id ? u : s.me,
            friends,
            dms: s.dms.map((d) => (d.recipient.id === u.id ? { ...d, recipient: u } : d)),
          };
        }),
      );
      rt.on('friend:update', ({ user, status, online, presence }) => {
        const prev = get().friends[user.id]?.status;
        set((s) => {
          const friends = { ...s.friends };
          if (status) friends[user.id] = { user, status };
          else delete friends[user.id];
          const statuses = { ...s.statuses };
          if (presence) statuses[user.id] = presence;
          return { friends, online: { ...s.online, [user.id]: online || undefined }, statuses };
        });
        if (status === 'incoming' && prev !== 'incoming') {
          playSound('message');
          notify(`${user.displayName} quer ser seu amigo.`, 'presence', user);
        } else if (status === 'friend' && prev === 'outgoing') {
          notify(`${user.displayName} aceitou seu pedido de amizade.`, 'presence', user);
        }
      });
      rt.on('message:new', (m) => {
        const s = get();
        const isDm = s.dms.some((d) => d.id === m.channelId);
        const isGuild = Object.values(s.guildData).some((g) => g.channels.some((c) => c.id === m.channelId));
        if (!isDm && !isGuild) get().loadDms(); // primeira mensagem de uma conversa nova
        if (isDm || !isGuild) {
          // Só conta como lida se a pessoa está mesmo olhando: conversa aberta e janela em foco (com a
          // janela atrás de outro programa ou na bandeja, a mensagem avisa e fica como não lida).
          const viewing = isViewing(m.channelId) && !document.hidden && document.hasFocus();
          set((st) => ({
            dms: st.dms
              .map((d) => (d.id === m.channelId ? { ...d, lastMessageAt: m.createdAt } : d))
              .sort((a, b) => b.lastMessageAt - a.lastMessageAt),
            unread:
              viewing || m.author.id === st.me?.id
                ? st.unread
                : { ...st.unread, [m.channelId]: (st.unread[m.channelId] || 0) + 1 },
          }));
          if (!viewing && m.author.id !== s.me?.id) {
            playSound('message');
            const text = m.content.length > 80 ? `${m.content.slice(0, 80)}…` : m.content;
            notify(
              STICKER_RE.test(m.content) ? `${m.author.displayName} enviou um sticker.` : `${m.author.displayName} diz: ${text}`,
              'presence',
              m.author,
            );
          }
        }
      });
      rt.on('call:ring', ({ dmId, from }) => {
        if (get().voice?.channelId === dmId) return;
        set({ incomingCall: { dmId, from } });
        showAppWindow();
        if (!get().dms.some((d) => d.id === dmId)) get().loadDms();
      });
      rt.on('call:declined', ({ dmId, by }) => {
        const v = get().voice;
        if (v?.channelId === dmId && v.peers.length === 0) {
          get().leaveVoice();
          playSound('callEnd');
          notify(`${by.displayName} recusou a chamada`, 'info');
        }
      });
      rt.on('message:new', (m) =>
        set((s) => {
          const list = s.messages[m.channelId];
          if (!list || list.some((x) => x.id === m.id)) return {};
          const typing = { ...s.typing, [m.channelId]: { ...(s.typing[m.channelId] || {}) } };
          delete typing[m.channelId][m.author.id];
          return { messages: { ...s.messages, [m.channelId]: [...list, m] }, typing };
        }),
      );
      rt.on('message:updated', (u) =>
        set((s) => {
          const list = s.messages[u.channelId];
          if (!list) return {};
          return {
            messages: {
              ...s.messages,
              [u.channelId]: list.map((m) => (m.id === u.id ? { ...m, content: u.content, editedAt: u.editedAt } : m)),
            },
          };
        }),
      );
      rt.on('message:deleted', ({ id, channelId }) =>
        set((s) => {
          const list = s.messages[channelId];
          if (!list) return {};
          return { messages: { ...s.messages, [channelId]: list.filter((m) => m.id !== id) } };
        }),
      );
      rt.on('typing', ({ channelId, user }) => {
        const tkey = `${channelId}:${user.id}`;
        clearTimeout(typingTimers.get(tkey));
        set((s) => ({ typing: { ...s.typing, [channelId]: { ...(s.typing[channelId] || {}), [user.id]: user } } }));
        typingTimers.set(
          tkey,
          setTimeout(
            () =>
              set((s) => {
                const c = { ...(s.typing[channelId] || {}) };
                delete c[user.id];
                return { typing: { ...s.typing, [channelId]: c } };
              }),
            4000,
          ),
        );
      });
      rt.on('music:state', (m) =>
        set((s) => {
          const music = { ...s.music };
          if (m.current || m.queue.length || m.history?.length) music[m.channelId] = m;
          else delete music[m.channelId];
          // O atraso da rede só faz o offset parecer menor; o maior observado é o mais fiel.
          return { music, serverOffset: Math.max(s.serverOffset, m.serverTime - Date.now()) };
        }),
      );
      rt.on('music:notice', ({ text }) => notify(text, 'info'));
      rt.on('voice:channel', ({ channelId, participants }) => {
        set((s) => {
          const voiceStates = { ...s.voiceStates };
          if (participants.length) voiceStates[channelId] = participants;
          else delete voiceStates[channelId];
          return { voiceStates };
        });
        // Quem ligou desistiu antes de atender.
        const call = get().incomingCall;
        if (call?.dmId === channelId && !participants.some((p) => p.user.id === call.from.id)) {
          set({ incomingCall: null });
          notify(`Chamada perdida de ${call.from.displayName}`, 'info');
        }
      });
      rt.on('channel:created', (ch) =>
        set((s) => {
          const g = s.guildData[ch.guildId];
          if (!g || g.channels.some((c) => c.id === ch.id)) return {};
          return { guildData: { ...s.guildData, [ch.guildId]: { ...g, channels: [...g.channels, ch] } } };
        }),
      );
      rt.on('channel:deleted', ({ guildId, channelId }) => {
        set((s) => {
          const g = s.guildData[guildId];
          if (!g) return {};
          return {
            guildData: { ...s.guildData, [guildId]: { ...g, channels: g.channels.filter((c) => c.id !== channelId) } },
          };
        });
        if (primary && get().view?.channelId === channelId) get().selectGuild(guildId);
      });
      rt.on('member:joined', ({ guildId, user }) =>
        set((s) => {
          const g = s.guildData[guildId];
          if (!g || g.members.some((m) => m.id === user.id)) return {};
          return { guildData: { ...s.guildData, [guildId]: { ...g, members: [...g.members, user] } } };
        }),
      );
      rt.on('member:left', ({ guildId, userId }) =>
        set((s) => {
          const g = s.guildData[guildId];
          if (!g) return {};
          return {
            guildData: { ...s.guildData, [guildId]: { ...g, members: g.members.filter((m) => m.id !== userId) } },
          };
        }),
      );
      rt.on('guild:deleted', ({ guildId }) =>
        get().forgetGuild(guildId, 'Um servidor do qual você participava foi excluído'),
      );
    },

    /** Depois de reconectar: recarrega listas e o canal aberto. */
    async resync() {
      const guilds = await api.get('/api/guilds').catch(() => null);
      if (!guilds) return;
      get().loadFriends();
      get().loadDms();
      if (kind === 'local') api.get('/api/lan/peers').then((lanPeers) => set({ lanPeers }), () => {});
      set({ guilds, guildData: {}, messages: {}, hasMore: {} });
      const { currentGuildId } = get();
      const view = ui().getState().view;
      if (primary && currentGuildId && guilds.some((g) => g.id === currentGuildId)) {
        await get().loadGuild(currentGuildId);
        if (view?.type === 'text') get().loadMessages(view.channelId);
      } else if (primary && guilds[0] && currentGuildId) get().selectGuild(guilds[0].id);
      if (view?.type === 'dm' && (view.conn || 'server') === key) get().loadMessages(view.channelId);
    },

    // ---------- Início: amigos e conversas diretas ----------
    goHome() {
      ui().setState({ currentGuildId: null, view: { type: 'friends' }, sidebarView: 'channels', mobilePane: 'list' });
    },

    async loadFriends() {
      const list = await api.get('/api/friends').catch(() => null);
      if (list)
        set((s) => ({
          friends: Object.fromEntries(list.map((f) => [f.user.id, f])),
          statuses: {
            ...s.statuses,
            ...Object.fromEntries(list.filter((f) => f.presence).map((f) => [f.user.id, f.presence])),
          },
        }));
    },

    async loadDms() {
      const dms = await api.get('/api/dms').catch(() => null);
      if (dms) set({ dms });
    },

    async sendFriendRequest(username) {
      const res = await api.post('/api/friends', { username });
      notify(
        res.status === 'friend' ? `Agora você e ${res.user.displayName} são amigos` : 'Pedido de amizade enviado',
        'info',
      );
    },
    acceptFriend: (id) => api.post(`/api/friends/${id}/accept`).catch((e) => notify(e.message)),
    removeFriend: (id) => api.del(`/api/friends/${id}`).catch((e) => notify(e.message)),

    /** Abre (ou cria) a conversa direta com alguém. */
    async openDm(userId) {
      const dm = await api.post('/api/dms', { userId });
      set((s) => ({ dms: [dm, ...s.dms.filter((d) => d.id !== dm.id)] }));
      get().selectDm(dm.id);
      return dm;
    },

    selectDm(dmId) {
      set((s) => ({ unread: { ...s.unread, [dmId]: 0 } }));
      setView({ currentGuildId: null, sidebarView: 'channels', view: { type: 'dm', channelId: dmId } });
      openPane();
      if (!get().messages[dmId]) get().loadMessages(dmId);
    },

    async callUser(userId) {
      const dm = await get().openDm(userId);
      await get().joinVoice(dm.id);
    },

    async answerCall() {
      const call = get().incomingCall;
      if (!call) return;
      set({ incomingCall: null });
      get().selectDm(call.dmId);
      await get().joinVoice(call.dmId);
    },

    declineCall() {
      const call = get().incomingCall;
      if (!call) return;
      rt?.send('call:decline', { dmId: call.dmId });
      set({ incomingCall: null });
    },

    // ---------- Perfil ----------
    fetchProfile: (userId) => api.get(`/api/users/${userId}`),

    async updateProfile(patch) {
      const res = await api.patch('/api/me/profile', patch);
      set((s) => ({ me: res.user, users: { ...s.users, [res.user.id]: res.user } }));
      return res;
    },

    async uploadAvatar(blob) {
      const user = await api.put('/api/me/avatar', blob);
      set((s) => ({ me: user, users: { ...s.users, [user.id]: user } }));
      return user;
    },

    async removeAvatar() {
      const user = await api.del('/api/me/avatar');
      set((s) => ({ me: user, users: { ...s.users, [user.id]: user } }));
      return user;
    },

    // ---------- Stickers ----------
    async loadStickers() {
      try {
        set({ stickers: await api.get('/api/stickers') });
      } catch (e) {
        notify(e.message);
      }
    },
    /** Envia uma imagem (PNG, JPEG, WebP ou GIF animado) para a coleção; o mesmo arquivo não duplica. */
    async uploadSticker(blob, name = '') {
      const st = await api.post(`/api/stickers?name=${encodeURIComponent(name)}`, blob);
      set((s) => (s.stickers && !s.stickers.some((x) => x.id === st.id) ? { stickers: [...s.stickers, st] } : {}));
      return st;
    },
    async deleteSticker(id) {
      await api.del(`/api/stickers/${id}`);
      set((s) => ({ stickers: (s.stickers || []).filter((x) => x.id !== id) }));
    },
    stickerBlob: (id) => api.blob(`/api/stickers/${id}/image`),

    /** Baixa a própria foto (para copiar o perfil local para outro servidor). */
    avatarBlob: () => {
      const me = get().me;
      return me?.avatarUrl ? api.blob(me.avatarUrl) : Promise.resolve(null);
    },

    // ---------- Status ----------
    async setMyStatus(status) {
      const prev = get().myStatus;
      set({ myStatus: status });
      const res = await rt?.request('status:set', { status });
      if (!res || res.error) {
        set({ myStatus: prev });
        return res?.error || 'Sem conexão com o servidor';
      }
      return null;
    },

    // ---------- Chamar atenção ----------
    /** Aviso local na conversa (não fica salvo): chamadas de atenção enviadas e recebidas. */
    pushNotice(channelId, notice) {
      set((s) => {
        const list = s.messages[channelId];
        if (!list) return {};
        const entry = { id: `notice-${Date.now()}-${Math.random()}`, notice: true, createdAt: Date.now(), ...notice };
        return { messages: { ...s.messages, [channelId]: [...list, entry] } };
      });
    },

    async sendNudge(channelId) {
      const res = await rt?.request('nudge:send', { channelId });
      if (!res || res.error) return notify(res?.error || 'Sem conexão com o servidor');
      get().pushNotice(channelId, { kind: 'nudge-out', delivered: res.delivered, refused: res.refused });
      playSound('nudge');
      shakeWindow();
      if (!res.delivered) {
        const dm = get().dms.find((d) => d.id === channelId);
        notify(
          res.refused
            ? dm
              ? `${dm.recipient.displayName} não está aceitando chamar atenção agora.`
              : 'Quem está aqui não aceita chamar atenção agora.'
            : 'Ninguém online para receber agora.',
          'info',
        );
      }
    },

    async setAllowNudges(allowNudges) {
      try {
        set({ nudgeSettings: await api.patch('/api/me/settings', { allowNudges }) });
      } catch (e) {
        notify(e.message);
      }
    },

    async setNudgeBlocked(userId, blocked) {
      try {
        const path = `/api/me/nudge-blocks/${userId}`;
        set({ nudgeSettings: blocked ? await api.put(path, {}) : await api.del(path) });
      } catch (e) {
        notify(e.message);
      }
    },

    setRepeatAlerts(on) {
      get().setAppearance({ repeatAlerts: on });
    },

    setSounds(on) {
      setSoundsEnabled(on);
      get().setAppearance({ sounds: on });
    },

    // ---------- Servidores e canais ----------
    async loadGuild(guildId) {
      const full = await api.get(`/api/guilds/${guildId}`);
      const { channels, members, ...guild } = full;
      set((s) => ({
        guildData: { ...s.guildData, [guildId]: { channels, members } },
        guilds: s.guilds.some((g) => g.id === guildId)
          ? s.guilds.map((g) => (g.id === guildId ? guild : g))
          : [...s.guilds, guild],
      }));
      return full;
    },

    async selectGuild(guildId) {
      set({ currentGuildId: guildId, lastGuildId: guildId, mobilePane: 'list' });
      let data = get().guildData[guildId];
      if (!data) {
        try {
          data = await get().loadGuild(guildId);
        } catch (e) {
          return notify(e.message);
        }
      }
      if (get().currentGuildId !== guildId) return;
      const last = get().lastChannel[guildId];
      const target = data.channels.find((c) => c.id === last) || data.channels.find((c) => c.type === 'text');
      set({ view: target ? { type: 'text', channelId: target.id } : null });
      if (target) get().loadMessages(target.id);
    },

    selectTextChannel(channelId) {
      const guildId = get().currentGuildId;
      set((s) => ({ view: { type: 'text', channelId }, lastChannel: { ...s.lastChannel, [guildId]: channelId } }));
      openPane();
      if (!get().messages[channelId]) get().loadMessages(channelId);
    },

    async loadMessages(channelId, older = false) {
      const current = get().messages[channelId] || [];
      const before = older && current.length ? `&before=${current[0].createdAt}` : '';
      try {
        const list = await api.get(`/api/channels/${channelId}/messages?limit=50${before}`);
        set((s) => ({
          messages: { ...s.messages, [channelId]: older ? [...list, ...(s.messages[channelId] || [])] : list },
          hasMore: { ...s.hasMore, [channelId]: list.length === 50 },
        }));
      } catch (e) {
        notify(e.message);
      }
    },

    async createGuild(name) {
      const g = await api.post('/api/guilds', { name });
      const { channels, members, ...guild } = g;
      set((s) => ({
        guilds: [...s.guilds.filter((x) => x.id !== g.id), guild],
        guildData: { ...s.guildData, [g.id]: { channels, members } },
      }));
      get().selectGuild(g.id);
    },

    async joinGuild(code) {
      const g = await api.post('/api/guilds/join', { code });
      const { channels, members, ...guild } = g;
      set((s) => ({
        guilds: [...s.guilds.filter((x) => x.id !== g.id), guild],
        guildData: { ...s.guildData, [g.id]: { channels, members } },
      }));
      get().selectGuild(g.id);
    },

    async leaveGuild(guildId) {
      await api.post(`/api/guilds/${guildId}/leave`);
      get().forgetGuild(guildId);
    },

    async deleteGuild(guildId) {
      await api.del(`/api/guilds/${guildId}`);
      get().forgetGuild(guildId);
    },

    forgetGuild(guildId, message) {
      if (get().voice?.guildId === guildId) get().leaveVoice();
      set((s) => {
        const guildData = { ...s.guildData };
        delete guildData[guildId];
        return { guilds: s.guilds.filter((g) => g.id !== guildId), guildData };
      });
      if (get().currentGuildId === guildId) {
        const next = get().guilds[0];
        if (next) get().selectGuild(next.id);
        else get().goHome();
      }
      if (message) notify(message, 'info');
    },

    async createChannel(guildId, name, type) {
      const ch = await api.post(`/api/guilds/${guildId}/channels`, { name, type });
      set((s) => {
        const g = s.guildData[guildId];
        if (!g || g.channels.some((c) => c.id === ch.id)) return {};
        return { guildData: { ...s.guildData, [guildId]: { ...g, channels: [...g.channels, ch] } } };
      });
    },

    deleteChannel: (channelId) => api.del(`/api/channels/${channelId}`).catch((e) => notify(e.message)),

    // ---------- Mensagens ----------
    async sendMessage(channelId, content) {
      const res = await rt?.request('message:send', { channelId, content });
      if (!res || res.error) {
        notify(res?.error || 'Sem conexão');
        return false;
      }
      return true;
    },
    async editMessage(messageId, content) {
      const res = await rt?.request('message:edit', { messageId, content });
      if (res?.error) notify(res.error);
    },
    async deleteMessage(messageId) {
      const res = await rt?.request('message:delete', { messageId });
      if (res?.error) notify(res.error);
    },
    sendTyping: (channelId) => rt?.send('typing', { channelId }),

    // ---------- Voz ----------
    async joinVoice(channelId) {
      if (get().voice?.channelId === channelId) {
        if (primary && !get().dms.some((d) => d.id === channelId)) {
          set({ view: { type: 'voice', channelId } });
          openPane();
        }
        return;
      }
      // Uma chamada por vez, em qualquer conexão.
      for (const other of connRegistry.values()) if (other !== store && other.getState().voice) other.getState().leaveVoice();
      if (voiceClient) get().leaveVoice();
      if (!rt || rt.status !== 'connected') return notify('Sem conexão com o servidor');
      const client = new VoiceClient({
        rt,
        iceServers: get().config?.iceServers || [],
        onNotice: (text) => notify(text, 'info'),
        onChange: (snap) => {
          if (voiceClient !== client) return;
          voiceSounds(get().voice, snap, notify);
          if (!snap.channelId) {
            voiceClient = null;
            set({ voice: null });
            if (snap.error) notify(snap.error, 'info');
            return;
          }
          set({ voice: snap });
        },
      });
      voiceClient = client;
      const isDm = get().dms.some((d) => d.id === channelId);
      if (!isDm && primary) {
        set({ view: { type: 'voice', channelId } });
        openPane();
      }
      try {
        const { selfMuted, selfDeafened } = ui().getState();
        const p = prefs();
        await client.join(channelId, {
          muted: selfMuted,
          deafened: selfDeafened,
          devices: p.devices,
          noiseSuppression: p.noiseSuppression !== false,
        });
        if (!client.state.micAvailable) {
          notify(
            window.isSecureContext
              ? 'Microfone indisponível — você entrou só para ouvir.'
              : 'O navegador bloqueia microfone, câmera e tela sem HTTPS. Você entrou só para ouvir — peça ao host para ativar HTTPS ou use o app PadoSpeak.',
            'info',
          );
        }
      } catch (e) {
        if (voiceClient === client) voiceClient = null;
        set({ voice: null });
        notify(e.message);
      }
    },

    leaveVoice() {
      const ch = get().voice?.channelId;
      voiceClient?.leave();
      voiceClient = null;
      set({ voice: null });
      if (primary && get().view?.type === 'voice' && get().view.channelId === ch) get().selectGuild(get().currentGuildId);
    },

    showVoice() {
      const v = get().voice;
      if (!v) return;
      if (v.dm) return get().selectDm(v.channelId);
      if (get().currentGuildId !== v.guildId) set({ currentGuildId: v.guildId });
      set({ view: { type: 'voice', channelId: v.channelId } });
      openPane();
    },

    /** Mudo/surdo valem para a chamada em qualquer conexão (o estado fica no principal). */
    toggleMute() {
      const muted = !ui().getState().selfMuted;
      ui().setState({ selfMuted: muted, ...(muted ? {} : { selfDeafened: false }) });
      for (const c of connRegistry.values()) c.getState()._applyAudio();
    },
    toggleDeafen() {
      ui().setState({ selfDeafened: !ui().getState().selfDeafened });
      for (const c of connRegistry.values()) c.getState()._applyAudio();
    },
    _applyAudio() {
      if (!voiceClient) return;
      const { selfMuted, selfDeafened } = ui().getState();
      voiceClient.setMuted(selfMuted);
      voiceClient.setDeafened(selfDeafened);
    },
    async toggleCamera() {
      if (!voiceClient) return;
      if (!window.isSecureContext) return notify(INSECURE_MSG);
      try {
        await voiceClient.setCamera(!voiceClient.camera);
      } catch (e) {
        notify(cameraError(e));
      }
    },
    /** Câmera frontal ↔ traseira (celular e tablet). */
    async flipCamera() {
      try {
        await voiceClient?.flipCamera();
      } catch (e) {
        notify(cameraError(e));
      }
    },
    async toggleScreen(preset) {
      if (!voiceClient) return;
      if (!window.isSecureContext) return notify(INSECURE_MSG);
      try {
        await voiceClient.setScreen(!voiceClient.screen, preset);
      } catch (e) {
        if (e.name !== 'NotAllowedError') notify(`Compartilhamento de tela: ${e.message}`);
      }
    },
    setScreenPreset: (preset) => voiceClient?.setScreenPreset(preset),
    setPeerVolume: (peerId, v) => voiceClient?.setPeerVolume(peerId, v),
    setStreamAudio: (peerId, opts) => voiceClient?.setStreamAudio(peerId, opts),
    setScreenAudioMuted: (muted) => voiceClient?.setScreenAudioMuted(muted),
    diagnostics: () => voiceClient?.diagnostics() || 'Fora de chamada.',
    latencyHistory: () => voiceClient?.latencyHistory() || { samples: [], series: [] },

    // ---------- Música ----------
    toggleMusicPanel: () =>
      ui().setState((s) =>
        s.sidebarView === 'music' ? { sidebarView: 'channels', mobilePane: 'list' } : { sidebarView: 'music', mobilePane: 'detail' },
      ),
    /** Celular: troca de aba (Conversas, Amigos, Servidores, Eu). */
    setMobileTab(tab) {
      const s = ui().getState();
      ui().setState({ mobileTab: tab, mobilePane: 'list', sidebarView: 'channels' });
      if (tab === 'chats' || tab === 'friends') {
        if (s.currentGuildId != null) s.goHome();
        if (tab === 'chats') ui().setState({ view: { type: 'friends' } });
      } else if (tab === 'servers' && s.currentGuildId == null && s.guilds.length) {
        s.selectGuild((s.guilds.find((g) => g.id === s.lastGuildId) || s.guilds[0]).id);
      }
    },
    /** Celular: botão "voltar" da tela cheia. */
    mobileBack() {
      const s = ui().getState();
      if (s.sidebarView === 'music') return s.toggleMusicPanel();
      ui().setState({ mobilePane: 'list' });
    },
    /** Notificações push deste aparelho (navegador / app instalado no celular). */
    pushKey: () => api.get('/api/push/key').then((r) => r.publicKey),
    pushSubscribe: (sub) => api.post('/api/push/subscribe', sub),
    pushUnsubscribe: (endpoint) => api.del('/api/push/subscribe', { endpoint }),
    /** O app foi para segundo plano ou voltou: o servidor decide se manda notificação push. */
    sendVisibility: (visible) => rt?.send('app:visibility', { visible }),

    /** Adiciona links à fila do canal de voz em que estou (cada link pode trazer várias músicas). */
    async addMusic(urls) {
      if (!rt) return;
      for (const url of urls) {
        set((s) => ({ musicAdding: s.musicAdding + 1 }));
        const res = await rt.request('music:add', { url }, 180000);
        set((s) => ({ musicAdding: s.musicAdding - 1 }));
        if (res.error) notify(res.error);
        else notify(res.added > 1 ? `${res.added} músicas adicionadas à fila` : `Na fila: ${res.title}`, 'info');
      }
    },

    async musicControl(op, trackId) {
      const res = await rt?.request(`music:${op}`, trackId ? { trackId } : {});
      if (res?.error) notify(res.error);
    },

    setMusicVolume(v) {
      get().setAppearance({ musicVolume: v });
    },

    async setNoiseSuppression(on) {
      get().setAppearance({ noiseSuppression: on });
      for (const c of connRegistry.values()) c.getState()._applyNoise(on);
    },
    async _applyNoise(on) {
      try {
        await voiceClient?.setNoiseSuppression(on);
      } catch (e) {
        notify(`Microfone: ${e.message}`);
      }
    },

    async setDevices(devices) {
      get().setAppearance({ devices: { ...(prefs().devices || {}), ...devices } });
      for (const c of connRegistry.values()) c.getState()._applyDevices();
    },
    async _applyDevices() {
      try {
        await voiceClient?.setDevices(prefs().devices);
      } catch (e) {
        notify(`Dispositivo: ${e.message}`);
      }
    },

    /** URL do áudio de uma faixa (o `<audio>` não manda cabeçalho, o token vai na query). */
    musicUrl: (id) => `${baseUrl}/api/music/stream/${id}?token=${encodeURIComponent(token || '')}`,
  }));

  connRegistry.set(key, store);
  syncConnKeys();

  // ---------- Player de música: segue o canal de voz em que estou ----------
  let player = null;
  store.subscribe((s) => {
    const state = s.voice ? s.music[s.voice.channelId] : null;
    if (!player && !state) return;
    player ||= new MusicPlayer();
    if (primary) globalThis.__padospeakMusic = player; // diagnóstico pelo DevTools
    const u = ui().getState();
    player.update({
      state,
      muted: u.selfDeafened,
      volume: u.prefs.musicVolume ?? 0.5,
      sinkId: u.prefs.devices?.output || '',
      streamUrl: s.musicUrl,
      serverNow: () => Date.now() + s.serverOffset,
    });
  });

  // ---------- Toques de chamada 1 a 1 ----------
  let stopRing = null;
  let stopRingback = null;
  let ringbackTimer = null;
  store.subscribe((s, prev) => {
    // Chamada recebida: toca até atender, recusar ou quem ligou desistir.
    if (s.incomingCall && !prev.incomingCall) stopRing = loopSound('ring', 2200);
    if (!s.incomingCall && prev.incomingCall) {
      stopRing?.();
      stopRing = null;
    }
    // Quem liga ouve o "chamando…" enquanto estiver sozinho na chamada 1 a 1.
    const waiting = Boolean(s.voice?.dm && s.voice.peers.length === 0);
    const wasWaiting = Boolean(prev.voice?.dm && prev.voice.peers.length === 0);
    if (waiting && !wasWaiting) {
      stopRingback = loopSound('ringback', 3000);
      const callId = s.voice.channelId;
      ringbackTimer = setTimeout(() => {
        const v = store.getState().voice;
        if (v?.channelId === callId && v.peers.length === 0) {
          store.getState().leaveVoice();
          notify('Ninguém atendeu a chamada', 'info');
        }
      }, CALL_TIMEOUT_MS);
    }
    if (!waiting && wasWaiting) {
      stopRingback?.();
      stopRingback = null;
      clearTimeout(ringbackTimer);
    }
  });

  // Perfis que já entraram neste PC: a tela de login mostra a foto de quem for digitado.
  if (kind === 'local' || (primary && !isDesktop)) {
    store.subscribe((s, prev) => s.me && s.me !== prev.me && rememberProfile(baseUrl, s.me));
  }

  return store;
}

const knownKey = (base) => `padospeak.knownProfiles:${base}`;

/** Guarda nome e foto de quem entrou (só neste PC), e quem foi o último. */
function rememberProfile(base, me) {
  const known = knownProfiles(base);
  known[me.username.toLowerCase()] = {
    id: me.id,
    username: me.username,
    displayName: me.displayName,
    avatarUrl: me.avatarUrl || null,
    avatarColor: me.avatarColor,
  };
  storage.set(knownKey(base), JSON.stringify(known));
  storage.set(`padospeak.lastProfile:${base}`, me.username);
}

export function knownProfiles(base) {
  try {
    return JSON.parse(storage.get(knownKey(base))) || {};
  } catch {
    return {};
  }
}

/** Último perfil que entrou neste PC (para já vir preenchido no login). */
export const lastProfile = (base) => storage.get(`padospeak.lastProfile:${base}`) || '';

/**
 * Toque numa notificação: `/?dm=<id>` abre a conversa; `/?friends=pending` abre os pedidos de amizade.
 * Também chamada quando o service worker avisa um app que já estava aberto.
 */
export function openFromUrl(url = location.href) {
  const q = new URL(url, location.origin).searchParams;
  const dm = q.get('dm');
  const friends = q.get('friends');
  if (!dm && !friends) return;
  if (new URL(url, location.origin).href === location.href) history.replaceState(null, '', '/');
  const ui = useStore.getState();
  if (dm) {
    const store = [...connRegistry.values()].find((c) => c.getState().dms.some((d) => d.id === dm));
    if (store) store.getState().selectDm(dm);
    else
      useStore
        .getState()
        .loadDms?.()
        .then(() => useStore.getState().dms.some((d) => d.id === dm) && useStore.getState().selectDm(dm))
        .catch(() => {});
  } else if (friends) {
    ui.setFriendsTab(friends === 'pending' ? 'pending' : 'online');
    ui.setMobileTab('friends');
  }
}

/** Voltou para a janela: a conversa que está aberta foi lida (some o número vermelho). */
function markViewedRead() {
  const v = useStore.getState().view;
  if (v?.type !== 'dm' || document.hidden) return;
  const store = getConn(v.conn);
  if (store.getState().unread[v.channelId]) store.setState((s) => ({ unread: { ...s.unread, [v.channelId]: 0 } }));
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    for (const c of connRegistry.values()) c.getState().sendVisibility(visible);
    if (visible && document.hasFocus()) markViewedRead();
  });
  window.addEventListener('focus', markViewedRead);
}

/** Fecha e esquece uma conexão secundária. */
export function dropConn(key) {
  const store = connRegistry.get(key);
  if (!store || key === 'server') return;
  store.getState().teardown();
  connRegistry.delete(key);
  syncConnKeys();
  const v = useStore.getState().view;
  if (v?.conn === key) useStore.getState().goHome();
}

/** O servidor de comunidade (e a interface). */
export const useStore = createConnStore({ key: 'server', kind: 'server', base: savedServerUrl(), primary: true });
syncConnKeys();

/** Conexão com uma chamada em andamento (só uma por vez), ou o servidor. */
export const activeVoiceConn = () => [...connRegistry.values()].find((c) => c.getState().voice) || useStore;

/** Store de uma conexão pela chave (o servidor quando não há outra). */
export const getConn = (key) => (key && connRegistry.get(key)) || useStore;

/** Onde mora o meu perfil: o nó local no app desktop, o servidor no navegador. */
export const primaryConn = () => (isDesktop ? connRegistry.get('local') || useStore : useStore);

// Exposto para diagnóstico pelo DevTools.
globalThis.__padospeakStore = useStore;
globalThis.__padospeakConns = connRegistry;
globalThis.__padospeak = {
  changeServer: (...a) => changeServer(...a),
  openLanDm: (...a) => openLanDm(...a),
  connectServer: (...a) => connectServer(...a),
};

// =====================================================================
// App desktop: perfil local, rede local e servidor de comunidade
// =====================================================================

/** Chave secreta deste PC, apresentada aos outros nós da rede (fixada por eles na primeira vez). */
function lanKey() {
  let k = storage.get('padospeak.lanKey');
  if (!k) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    k = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    storage.set('padospeak.lanKey', k);
  }
  return k;
}

let serverRetry = null;
/**
 * Senha do perfil local digitada nesta sessão, só na memória (nunca no disco): permite entrar em silêncio
 * no servidor de comunidade quando o endereço muda. Abrindo o app pelo token salvo, ela não existe.
 */
let localPassword = null;

async function bootDesktop() {
  let url;
  try {
    url = await localNodeUrl();
  } catch (e) {
    useStore.setState({ phase: 'auth', localError: e?.message || String(e) });
    return;
  }
  const local = connRegistry.get('local') || createConnStore({ key: 'local', kind: 'local', base: url });
  if (local.getState().baseUrl !== url) local.getState().setBase(url);
  try {
    const me = await createApi(
      () => url,
      () => loadToken(url),
    ).get('/api/me');
    await enterLocal(local, me);
  } catch {
    useStore.setState({ phase: 'auth' });
  }
}

/** Passa a usar a sessão do servidor de comunidade deste perfil local (cada perfil tem a sua). */
async function useProfileSession(me) {
  useStore.getState().teardown();
  profileScope = me.id;
  const url = useStore.getState().baseUrl;
  // Até a 1.2.0 havia uma sessão só por PC: ela passa para este perfil apenas se for a conta dele.
  const legacy = url && loadToken(url);
  if (legacy && !loadToken(url, me.id)) {
    try {
      const owner = await createApi(
        () => url,
        () => legacy,
      ).get('/api/me');
      // De outro perfil: fica guardada (sem uso) até o dono dela entrar.
      if (owner.username.toLowerCase() === me.username.toLowerCase()) {
        saveToken(url, legacy, me.id);
        saveToken(url, null);
      }
    } catch (e) {
      // Servidor fora do ar: decide na próxima vez. Sessão expirada: descarta.
      if (e instanceof ApiError) saveToken(url, null);
    }
  }
  useStore.getState().reloadToken();
}

async function enterLocal(local, me, password, token) {
  if (token) await local.getState().enterWithToken(token, me);
  else await local.getState().enterApp(me);
  await useProfileSession(me);
  useStore.setState({ phase: 'app', view: { type: 'friends' }, currentGuildId: null });
  startLanMesh();
  connectServer({ username: me.username, password });
}

/** Login ou criação do perfil local (funciona sem internet). */
export async function localAuthenticate(mode, form) {
  const local = connRegistry.get('local');
  if (!local) throw new Error(useStore.getState().localError || 'O perfil local ainda não iniciou');
  const res = await createApi(
    () => local.getState().baseUrl,
    () => null,
  ).post(`/api/auth/${mode}`, form);
  localPassword = form.password;
  await enterLocal(local, res.user, form.password, res.token);
}

/** Sai do perfil local (e de tudo o que veio com ele). */
export async function localLogout() {
  localPassword = null;
  stopLanMesh();
  for (const key of [...connRegistry.keys()]) if (key.startsWith('peer:')) dropConn(key);
  useStore.getState().teardown();
  useStore.setState({ serverStatus: 'off' });
  clearTimeout(serverRetry);
  profileScope = null;
  useStore.getState().reloadToken();
  await connRegistry.get('local')?.getState().logout();
  useStore.setState({ phase: 'auth', view: null });
}

/**
 * Conecta ao servidor de comunidade sem incomodar: usa o token salvo; sem token, tenta as credenciais do
 * perfil local. Se a conta não existir lá (ou a senha for outra), fica só no local até a pessoa entrar
 * pela página Hostear. Servidor fora do ar: tenta de novo a cada minuto.
 */
export async function connectServer({ username, password = localPassword } = {}) {
  clearTimeout(serverRetry);
  const st = useStore.getState();
  const url = st.baseUrl;
  if (!url) return;
  useStore.setState({ serverStatus: 'connecting' });
  const api = createApi(
    () => url,
    () => loadToken(url, profileScope),
  );
  try {
    if (loadToken(url, profileScope)) {
      try {
        const me = await api.get('/api/me');
        await st.enterApp(me);
        await syncProfileTo(useStore);
        return;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        saveToken(url, null, profileScope);
        if (!password) return useStore.setState({ serverStatus: 'login' });
      }
    }
    if (!username || !password) return useStore.setState({ serverStatus: 'login' });
    try {
      await st.authenticate('login', { username, password });
      await syncProfileTo(useStore);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return useStore.setState({ serverStatus: 'mismatch' });
      throw e;
    }
  } catch {
    useStore.setState({ serverStatus: 'unreachable' });
    serverRetry = setTimeout(() => {
      if (useStore.getState().serverStatus === 'unreachable') connectServer({ username, password });
    }, SERVER_RETRY_MS);
  }
}

/** Entra no servidor com outra conta (ou cria uma), pela janela de login do servidor. */
export async function serverAuthenticate(mode, form) {
  clearTimeout(serverRetry);
  await useStore.getState().authenticate(mode, form);
  await syncProfileTo(useStore);
}

/** Troca o endereço do servidor de comunidade (página Hostear) e tenta conectar. */
export async function changeServer(url) {
  clearTimeout(serverRetry);
  useStore.getState().teardown();
  saveServerUrl(url);
  useStore.getState().setBase(url);
  const me = connRegistry.get('local')?.getState().me;
  await connectServer({ username: me?.username });
}

export function disconnectServer() {
  clearTimeout(serverRetry);
  useStore.getState().logout();
  useStore.setState({ serverStatus: 'login' });
}

/**
 * O perfil local dita o perfil nos outros lugares — mas só onde a conta é a mesma (mesmo usuário):
 * no servidor de comunidade quando o login bate, e nos PCs da rede (lá sempre é o próprio perfil).
 */
export async function syncProfileTo(target) {
  const local = connRegistry.get('local');
  const mine = local?.getState().me;
  const theirs = target.getState().me;
  if (!mine || !theirs || target === local) return;
  if (target.getState().kind === 'server' && theirs.username.toLowerCase() !== mine.username.toLowerCase()) return;
  try {
    const patch = {};
    for (const k of ['displayName', 'bio', 'nameColor', 'bioColor', 'bannerColor']) {
      if ((mine[k] || '') !== (theirs[k] || '')) patch[k] = mine[k] || '';
    }
    if (Object.keys(patch).length) await target.getState().updateProfile(patch);
    const syncKey = `padospeak.avatarSync:${target.getState().baseUrl}#${theirs.id}`;
    const synced = storage.get(syncKey);
    const want = mine.avatarUrl || '';
    if (want !== synced || (!!want !== !!theirs.avatarUrl)) {
      if (want) {
        const blob = await local.getState().avatarBlob();
        if (blob) await target.getState().uploadAvatar(blob);
      } else if (theirs.avatarUrl) await target.getState().removeAvatar();
      storage.set(syncKey, want);
    }
  } catch (e) {
    console.warn('[perfil] sincronização', e);
  }
}

/** Depois de editar o perfil local: leva a mudança para o servidor e para os PCs da rede. */
export function syncProfileEverywhere() {
  for (const [key, store] of connRegistry) if (key !== 'local') syncProfileTo(store);
}

/** Status escolhido vale em todas as conexões. */
export async function setStatusEverywhere(status) {
  const errors = [];
  for (const store of connRegistry.values()) {
    if (store.getState().rtStatus !== 'connected') continue;
    const e = await store.getState().setMyStatus(status);
    if (e) errors.push(e);
  }
  if (errors.length) useStore.getState().notify(errors[0]);
}

// ---------- Malha da rede local ----------
// Cada conversa entre dois PCs fica no nó de quem tem o menor id. Então este app se conecta, como
// convidado, aos nós dos perfis com id menor que o seu; os de id maior se conectam ao nó dele.

let meshUnsub = null;
const peerSessions = new Map(); // nodeUrl -> Promise

export function startLanMesh() {
  stopLanMesh();
  const local = connRegistry.get('local');
  if (!local) return;
  const reconcile = () => {
    const { lanPeers, me } = local.getState();
    if (!me) return;
    const owners = new Set(lanPeers.filter((p) => p.id < me.id).map((p) => p.nodeUrl));
    for (const nodeUrl of owners) if (!connRegistry.has(`peer:${nodeUrl}`) && !peerSessions.has(nodeUrl)) openPeer(nodeUrl);
    for (const key of [...connRegistry.keys()]) {
      if (key.startsWith('peer:') && !owners.has(key.slice(5))) dropConn(key);
    }
  };
  meshUnsub = local.subscribe((s, prev) => (s.lanPeers !== prev.lanPeers || s.me !== prev.me) && reconcile());
  reconcile();
}

function stopLanMesh() {
  meshUnsub?.();
  meshUnsub = null;
}

/** Entra como convidado no nó de outro PC da rede. */
function openPeer(nodeUrl) {
  const job = (async () => {
    const me = connRegistry.get('local')?.getState().me;
    if (!me) return;
    const res = await createApi(
      () => nodeUrl,
      () => null,
    ).post('/api/lan/session', {
      userId: me.id,
      username: me.username,
      displayName: me.displayName,
      avatarColor: me.avatarColor,
      bio: me.bio,
      nameColor: me.nameColor,
      bioColor: me.bioColor,
      bannerColor: me.bannerColor,
      key: lanKey(),
    });
    const key = `peer:${nodeUrl}`;
    const store = connRegistry.get(key) || createConnStore({ key, kind: 'peer', base: nodeUrl });
    await store.getState().enterWithToken(res.token, res.user);
    await syncProfileTo(store);
    const st = connRegistry.get('local')?.getState().myStatus;
    if (st && st !== 'online') store.getState().setMyStatus(st);
  })()
    .catch((e) => console.warn('[rede local]', nodeUrl, e?.message || e))
    .finally(() => peerSessions.delete(nodeUrl));
  peerSessions.set(nodeUrl, job);
  return job;
}

/** Abre a conversa com um perfil da rede, no nó de quem é o "dono" dela. */
export async function openLanDm(peer, { call = false } = {}) {
  const local = connRegistry.get('local');
  const me = local?.getState().me;
  if (!me) return;
  let store = local;
  if (peer.id < me.id) {
    store = connRegistry.get(`peer:${peer.nodeUrl}`);
    if (!store) {
      await openPeer(peer.nodeUrl);
      store = connRegistry.get(`peer:${peer.nodeUrl}`);
    }
    if (!store) return useStore.getState().notify(`Não foi possível conectar ao PC de ${peer.displayName}`);
  }
  try {
    if (call) await store.getState().callUser(peer.id);
    else await store.getState().openDm(peer.id);
  } catch (e) {
    useStore
      .getState()
      .notify(
        e instanceof ApiError && e.status === 404
          ? `${peer.displayName} ainda está se conectando. Tente de novo em alguns segundos.`
          : e.message,
      );
  }
}

// ---------- Stickers ----------

/** Onde mora a minha coleção de stickers: o perfil local no desktop, o servidor no navegador. */
export const stickerHome = () => primaryConn();

/**
 * Manda um sticker numa conversa de qualquer conexão. Se a conversa for em outro servidor (ou num PC
 * da rede), a imagem é copiada para lá antes — cada servidor guarda os stickers que circulam nele.
 */
export async function sendSticker(connKey, channelId, sticker) {
  const target = getConn(connKey);
  try {
    if (sticker.emote) return await target.getState().sendMessage(channelId, `[sticker:emote:${sticker.emote}]`);
    const home = stickerHome();
    let id = sticker.id;
    if (home !== target) {
      const blob = await home.getState().stickerBlob(sticker.id);
      id = (await target.getState().uploadSticker(blob, sticker.name)).id;
    }
    return await target.getState().sendMessage(channelId, `[sticker:${id}]`);
  } catch (e) {
    useStore.getState().notify(`Sticker: ${e.message}`);
    return false;
  }
}

// ---------- Aparência: tema e cena aplicados na raiz do documento ----------
function applyAppearance(p) {
  const root = document.documentElement;
  // Padrão: tema claro (Aero). "system" segue o Windows.
  const choice = p.theme || 'light';
  const theme = choice === 'light' || choice === 'dark' ? choice : null;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.dataset.scene = String(p.scene ?? 0);
  // Cor do sistema: o CSS deriva dela os tons de seleção, abas, links e a cena "Sistema".
  if (/^#[0-9a-f]{6}$/i.test(p.accent || '')) {
    root.style.setProperty('--accent', p.accent);
    root.dataset.accent = '1';
  } else {
    root.style.removeProperty('--accent');
    delete root.dataset.accent;
  }
}
applyAppearance(useStore.getState().prefs);
useStore.subscribe((s, prev) => s.prefs !== prev.prefs && applyAppearance(s.prefs));
