import { create } from 'zustand';
import { createApi, loadToken, saveToken, savedServerUrl, saveServerUrl, normalizeUrl, ApiError, storage } from './lib/api.js';
import { Realtime } from './lib/realtime.js';
import { VoiceClient } from './lib/voice.js';
import { MusicPlayer } from './lib/music.js';
import { isPanel, isDesktop, isTauri, localNodeUrl } from './lib/env.js';
import { playSound, loopSound, setSoundsEnabled } from './lib/sounds.js';
import { shakeWindow, flashTaskbar } from './lib/attention.js';
import { systemNotify, showAppWindow, appHasFocus } from './lib/background.js';
import { currentLayout, isStandalone, isTouch } from './lib/layout.js';
import { plain } from './lib/text.js';
import { syncPush, disablePush } from './lib/pwa.js';
import { applyHotkeys, hotkeysOf } from './lib/hotkeys.js';
import { NearbyProbe, deviceLabel } from './lib/nearby.js';

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

/**
 * Mensagem com sticker: `[sticker:<id>]` (da coleção) ou `[sticker:emote:<código>]` (padrão), com um
 * texto opcional na linha de baixo.
 */
export const STICKER_RE = /^\[sticker:(emote:)?([^\]\s]+)\](?:\n([\s\S]*))?$/;
/** Mensagem de voz: `[voz:<id>:<duração ms>:<tipo>]`. */
export const VOICE_RE = /^\[voz:([0-9a-f]{32}):(\d+):([^:\]]*)\]$/;

/** Como uma mensagem aparece num aviso ("diz: …", "enviou uma foto"…). */
export function messageSummary(content) {
  const file = FILE_RE.exec(content);
  if (file) {
    const nsfw = file[3].startsWith(NSFW_PREFIX);
    const mime = nsfw ? file[3].slice(NSFW_PREFIX.length) : file[3];
    const what = mime.startsWith('image/') ? 'uma foto' : mime.startsWith('video/') ? 'um vídeo' : nsfw ? 'um arquivo' : `o arquivo ${file[4]}`;
    return { verb: `enviou ${what}${nsfw ? ' (NSFW)' : ''}`, text: file[5] || '' };
  }
  if (VOICE_RE.test(content)) return { verb: 'enviou uma mensagem de voz', text: '' };
  const sticker = STICKER_RE.exec(content);
  if (sticker) return { verb: 'enviou um sticker', text: sticker[3] || '' };
  return { verb: 'diz', text: content };
}

/** Texto do aviso de uma mensagem: "Ana diz: oi" / "Ana enviou uma foto: legenda". */
export function messageNotice(author, content) {
  const { verb, text } = messageSummary(content);
  const t = plain(text).trim();
  const cut = t.length > 80 ? `${t.slice(0, 80)}…` : t;
  return cut ? `${author.displayName} ${verb}: ${cut}` : `${author.displayName} ${verb}.`;
}

/** Notificações de cada servidor (iguais às do servidor quando ainda não foram mudadas). */
export const DEFAULT_NOTIFY = { messages: 'mentions', mutedChannels: [], voiceJoin: false, streams: false, members: false };

/** Todas as conexões abertas (chave → store). A lista de chaves vive em `useStore.connKeys`. */
export const connRegistry = new Map();
/** O jogo em foco no app do Windows ({ type, name, since } ou null), contado a todas as conexões. */
let myActivity = null;
export function setMyActivity(activity) {
  myActivity = activity;
  for (const c of connRegistry.values()) c.getState()._sendActivity();
}
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
  let myPeerId = null;
  // Vistos: o que já recebi/li em cada conversa, mandado ao servidor com um pequeno atraso.
  const marks = new Map(); // channelId -> { delivered, read }
  const sentMarks = new Map();
  const markTimers = new Map();
  const flushMarks = (channelId) => {
    clearTimeout(markTimers.get(channelId));
    markTimers.set(
      channelId,
      setTimeout(() => {
        const m = marks.get(channelId);
        const sent = sentMarks.get(channelId) || { delivered: 0, read: 0 };
        if (!m || (m.delivered <= sent.delivered && m.read <= sent.read)) return;
        rt?.send('read:mark', { channelId, delivered: m.delivered, read: m.read || undefined });
        sentMarks.set(channelId, { ...m });
      }, 700),
    );
  };
  // Confirma (com uma conexão direta, sem servidor no meio) quem está mesmo na mesma rede local.
  const probe = new NearbyProbe({
    send: (to, data) => rt?.send('lan:signal', { to, data }),
    onResult: (peerId, ok) =>
      store.setState((s) => {
        const nearbyOk = { ...s.nearbyOk };
        if (ok) nearbyOk[peerId] = true;
        else delete nearbyOk[peerId];
        return { nearbyOk };
      }),
  });
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
  const notify = (text, kind2, user, url) => ui().getState().notify(text, kind2, user, baseUrl, url);
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
    activities: {}, // userId -> { type: "playing", name, since } (jogo em foco, contado pelo app do Windows)
    iceServers: null, // STUN/TURN do `ready` (com a senha temporária do TURN)
    myStatus: 'online', // online | away | busy | invisible
    nudgeSettings: null, // { allowNudges, nudgeBlocks: User[] }
    marks: { hidden: {}, nsfw: {} }, // só para mim: mensagens excluídas e fotos marcadas como NSFW (id -> true)
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
    voiceMembersOpen: false, // tela de voz: lista de membros aberta (começa recolhida)
    lastHomeView: null, // o que estava aberto no Início antes de ir para um servidor
    focusRequest: null, // { userId }: destacar a tela dessa pessoa ao abrir a chamada
    users: {}, // atualizações de perfil recebidas (id -> usuário)
    friends: {}, // userId -> { user, status: friend | incoming | outgoing }
    dms: [], // conversas diretas, mais recentes primeiro
    unread: {}, // dmId -> mensagens não lidas
    incomingCall: null, // { dmId, from }
    sidebarView: 'channels', // channels | music
    music: {}, // canal de voz -> estado da fila (music:state)
    serverOffset: 0, // relógio do servidor − relógio local (ms)
    musicLibrary: { guildId: null, favorites: [], top: [] }, // favoritas e mais tocadas
    musicAdding: 0,
    guildNotify: {}, // guildId -> o que avisar nesse servidor (veja DEFAULT_NOTIFY)
    nearby: [], // aparelhos na mesma rede: { peerId, user, device, direct }
    nearbyOk: {}, // peerId -> true quando a conexão direta confirmou a mesma rede local
    reads: {}, // channelId -> { userId: { deliveredAt, readAt } } (os "vistos")
    myBackground: null, // imagem de fundo da tela de início (caminho no servidor)
    appAdmin: null, // { canView, owner }: painel do administrador do app
    friendsTab: 'online', // online | all | pending | add
    modal: null,
    sharePending: null, // compartilhado pelo celular: { files, text, target }
    toast: null,

    // ---------- Interface (só faz sentido no principal) ----------
    openModal: (modal) => ui().setState({ modal }),
    closeModal: () => ui().setState({ modal: null }),
    /** Aviso no canto. `kind`: error | info | presence (com a foto de `user`, servida por `base`). */
    /** `url`: para onde o aviso leva ao ser clicado (ex.: `/?dm=<id>`), aqui e na notificação do Windows. */
    notify(text, kind2 = 'error', user = null, base = null, url = null) {
      if (!primary) return notify(text, kind2, user, url);
      const id = Date.now() + Math.random();
      set({ toast: { text, kind: kind2, user, base: base || baseUrl, id, url } });
      // App fora de foco (atrás de outro programa, minimizado ou na bandeja): também avisa pelo Windows.
      if (kind2 === 'presence') systemNotify(text, user, url);
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
    /** Painel do administrador do app (só para quem tem acesso). */
    goAdmin: () => ui().setState({ phase: 'admin' }),
    leaveAdmin: () => ui().setState({ phase: 'app' }),
    adminOverview: (days) => api.get(`/api/admin/overview?days=${days}`),
    adminViewers: () => api.get('/api/admin/viewers'),
    grantAdmin: (username) => api.put('/api/admin/viewers', { username }),
    revokeAdmin: (userId) => api.del(`/api/admin/viewers/${userId}`),

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
        activities: {},
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
        marks: { hidden: {}, nsfw: {} },
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
        .then((nudgeSettings) => set({ nudgeSettings, myBackground: nudgeSettings.backgroundUrl || null }))
        .catch(() => {});
      if (kind === 'server') {
        api
          .get('/api/me/notify')
          .then((guildNotify) => set({ guildNotify }))
          .catch(() => {});
        api
          .get('/api/admin/access')
          .then((appAdmin) => set({ appAdmin }))
          .catch(() => set({ appAdmin: null }));
      }
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
      rt.on('ready', (d) => {
        if (document.visibilityState !== 'visible') rt?.send('app:visibility', { visible: false });
        // Aparelhos na mesma rede (só no servidor de comunidade; o nó local tem a rede local própria).
        if (kind === 'server') {
          myPeerId = d.peerId;
          set({ nearby: [], nearbyOk: {} });
          get().lanHello();
          // Para o painel do administrador: onde o app está aberto.
          rt?.send('app:hello', appPlatform());
        }
      });
      rt.on('lan:nearby', ({ peers }) => {
        set({ nearby: peers });
        probe.update(peers, myPeerId);
      });
      rt.on('lan:signal', ({ from, data }) => probe.signal(from, data));
      rt.on('read:mark', ({ channelId, userId, deliveredAt, readAt }) =>
        set((st) => ({ reads: { ...st.reads, [channelId]: { ...st.reads[channelId], [userId]: { deliveredAt, readAt } } } })),
      );
      rt.on('me:background', ({ url }) => set({ myBackground: url }));
      rt.on('admin:access', (appAdmin) => {
        set({ appAdmin });
        if (!appAdmin.canView && primary && get().phase === 'admin') set({ phase: 'app' });
      });
      // Moderação de voz.
      rt.on('voice:move', ({ channelId, by }) => {
        const ch = Object.values(get().guildData)
          .flatMap((g) => g.channels)
          .find((c) => c.id === channelId);
        notify(`${by.displayName} moveu você para 🔊 ${ch?.name || 'outro canal'}.`, 'info');
        get().joinVoice(channelId);
      });
      rt.on('voice:moderated', ({ action, by }) => {
        if (action === 'disconnect') notify(`${by.displayName} desconectou você do canal de voz.`, 'info');
      });
      rt.on('voice:moved', ({ user, from, to, by, sound }) => {
        const mine = get().voice?.channelId;
        const me = get().me?.id;
        // Som para quem está nos canais envolvidos (se o servidor deixou ligado).
        if (sound && (mine === from || mine === to || user.id === me)) playSound('moved');
        if (user.id !== me && (mine === from || mine === to)) notify(`${by.displayName} moveu ${user.displayName}.`, 'info');
      });
      rt.on('ready', (d) => {
        set({
          online: Object.fromEntries(d.online.map((id) => [id, true])),
          statuses: d.statuses || {},
          myStatus: d.selfStatus || 'online',
          voiceStates: d.voice || {},
          music: Object.fromEntries((d.music || []).map((m) => [m.channelId, m])),
          serverOffset: d.serverTime - Date.now(),
          activities: d.activities || {},
          // STUN/TURN com a senha temporária deste login (o TURN só vem aqui, nunca no /api/config).
          iceServers: d.iceServers || null,
        });
        get()._sendActivity();
        get().loadMarks();
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
      rt.on('presence:update', ({ userId, online, status, activity }) => {
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
          const activities = { ...st.activities };
          if (online && activity) activities[userId] = activity;
          else delete activities[userId];
          return { online: { ...st.online, [userId]: online || undefined }, statuses, activities };
        });
      });
      rt.on('status:self', ({ status }) => set({ myStatus: status }));
      rt.on('nudge', ({ channelId, dm, from }) => {
        if (dm && !get().dms.some((d) => d.id === channelId)) get().loadDms();
        get().pushNotice(channelId, { kind: 'nudge-in', author: from });
        playSound('nudge');
        shakeWindow();
        flashTaskbar();
        notify(`${from.displayName} chamou a sua atenção!`, 'presence', from, dm ? `/?dm=${channelId}` : `/?channel=${channelId}`);
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
          notify(`${user.displayName} quer ser seu amigo.`, 'presence', user, '/?friends=pending');
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
          const viewing = isViewing(m.channelId) && appHasFocus();
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
            notify(messageNotice(m.author, m.content), 'presence', m.author, `/?dm=${m.channelId}`);
          }
        } else if (m.author.id !== s.me?.id && !(isViewing(m.channelId) && appHasFocus())) {
          // Canal de servidor: avisa conforme as notificações escolhidas para o servidor.
          const guildId = Object.entries(s.guildData).find(([, g]) => g.channels.some((c) => c.id === m.channelId))?.[0];
          const n = { ...DEFAULT_NOTIFY, ...s.guildNotify[guildId] };
          const me = s.me?.username?.toLowerCase();
          const mentioned = Boolean(me) && new RegExp(`(^|[^\\w.])@${me.replace(/\./g, '\\.')}(?![\\w])`, 'i').test(plain(m.content));
          const wants =
            n.messages === 'all' ? mentioned || !n.mutedChannels.includes(m.channelId) : n.messages === 'mentions' && mentioned;
          if (wants) {
            const ch = s.guildData[guildId].channels.find((c) => c.id === m.channelId);
            playSound('message');
            notify(`${messageNotice(m.author, m.content)} (#${ch?.name})`, 'presence', m.author, `/?channel=${m.channelId}`);
          }
        }
      });
      rt.on('message:expires', ({ id, channelId, expiresAt }) =>
        set((s) => {
          const list = s.messages[channelId];
          if (!list) return {};
          return { messages: { ...s.messages, [channelId]: list.map((m) => (m.id === id ? { ...m, expiresAt } : m)) } };
        }),
      );
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
      rt.on('message:new', (m) => {
        if (m.author.id !== get().me?.id) get().markReceived(m.channelId, m.createdAt);
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
      rt.on('message:reactions', ({ channelId, messageId, reactions }) =>
        set((s) => {
          const list = s.messages[channelId];
          if (!list) return {};
          return {
            messages: { ...s.messages, [channelId]: list.map((m) => (m.id === messageId ? { ...m, reactions } : m)) },
          };
        }),
      );
      rt.on('mark:update', ({ kind: mark, id, on }) =>
        set((s) => (s.marks[mark] ? { marks: { ...s.marks, [mark]: { ...s.marks[mark], [id]: on || undefined } } } : {})),
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
      rt.on('voice:channel', ({ guildId, channelId, dm, participants }) => {
        // Notificações do servidor: alguém entrou num canal de voz ou começou a transmitir.
        const s0 = get();
        const n = !dm && guildId && s0.guildNotify[guildId];
        const inThisCall = s0.voice?.channelId === channelId; // dentro da chamada já há sons próprios
        if (n && (n.voiceJoin || n.streams) && !inThisCall) {
          const before = new Map((s0.voiceStates[channelId] || []).map((p) => [p.peerId, p]));
          const ch = s0.guildData[guildId]?.channels.find((c) => c.id === channelId);
          for (const p of participants) {
            if (p.user.id === s0.me?.id) continue;
            const was = before.get(p.peerId);
            if (!was && n.voiceJoin && !participants.some((o) => o !== p && o.user.id === p.user.id))
              notify(`${p.user.displayName} entrou em 🔊 ${ch?.name || 'um canal de voz'}.`, 'presence', p.user);
            else if (was && !was.screen && p.screen && n.streams)
              notify(`${p.user.displayName} começou a transmitir em 🔊 ${ch?.name || 'um canal de voz'}.`, 'presence', p.user);
          }
        }
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
      rt.on('member:joined', ({ guildId, user }) => {
        const s = get();
        if (user.id !== s.me?.id && s.guildNotify[guildId]?.members) {
          const g = s.guilds.find((x) => x.id === guildId);
          notify(`${user.displayName} entrou em ${g?.name || 'um servidor'}.`, 'presence', user);
        }
        set((st) => {
          const g = st.guildData[guildId];
          if (!g || g.members.some((m) => m.id === user.id)) return {};
          return { guildData: { ...st.guildData, [guildId]: { ...g, members: [...g.members, user] } } };
        });
      });
      rt.on('member:left', ({ guildId, userId }) =>
        set((s) => {
          const g = s.guildData[guildId];
          if (!g) return {};
          return {
            guildData: { ...s.guildData, [guildId]: { ...g, members: g.members.filter((m) => m.id !== userId) } },
          };
        }),
      );
      rt.on('guild:updated', (g) => get().applyGuild(g));
      rt.on('channel:updated', (ch) => get()._upsertChannel(ch));
      rt.on('member:perms', ({ guildId, userId, perms, custom }) => get()._applyPerms(guildId, userId, perms, custom !== false));
      // Canais visíveis mudaram (canal privado, ou virei/deixei de ser admin): recarrega o servidor.
      rt.on('guild:refresh', async ({ guildId }) => {
        if (!get().guildData[guildId]) return;
        try {
          const data = await get().loadGuild(guildId);
          const ch = get().view?.channelId;
          const inGuild = get().currentGuildId === guildId;
          if (primary && inGuild && ch && get().view?.type !== 'dm' && !data.channels.some((c) => c.id === ch))
            get().selectGuild(guildId);
        } catch {
          /* sem acesso: o próprio servidor avisa */
        }
      });
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

    /** Minhas marcas (excluir para mim, NSFW para mim). Servidor antigo, sem elas: fica tudo vazio. */
    async loadMarks() {
      try {
        const { hidden = [], nsfw = [] } = await api.get('/api/me/marks');
        const map = (ids) => Object.fromEntries(ids.map((id) => [id, true]));
        set({ marks: { hidden: map(hidden), nsfw: map(nsfw) } });
      } catch {
        /* servidor sem marcas */
      }
    },

    /** Marca (ou desmarca) uma mensagem só para mim: `hidden` (excluir para mim) ou `nsfw`. */
    async setMark(mark, id, on) {
      const apply = (v) => set((s) => ({ marks: { ...s.marks, [mark]: { ...s.marks[mark], [id]: v || undefined } } }));
      apply(on);
      try {
        await (on ? api.put(`/api/me/marks/${mark}/${id}`) : api.del(`/api/me/marks/${mark}/${id}`));
      } catch (e) {
        apply(!on);
        notify(e instanceof ApiError && [404, 405].includes(e.status) ? 'Este servidor ainda não tem essa opção: atualize o servidor.' : e.message);
      }
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
      const { guild, data } = splitGuild(full);
      set((s) => ({
        guildData: { ...s.guildData, [guildId]: data },
        guilds: s.guilds.some((g) => g.id === guildId)
          ? s.guilds.map((g) => (g.id === guildId ? guild : g))
          : [...s.guilds, guild],
      }));
      return data;
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
        if (!older) {
          api
            .get(`/api/channels/${channelId}/reads`)
            .then((rows) => set((st) => ({ reads: { ...st.reads, [channelId]: Object.fromEntries(rows.map((r) => [r.userId, r])) } })))
            .catch(() => {});
          const last = [...list].reverse().find((m) => m.author.id !== get().me?.id);
          if (last) get().markReceived(channelId, last.createdAt);
        }
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
      const { guild, data } = splitGuild(g);
      set((s) => ({
        guilds: [...s.guilds.filter((x) => x.id !== g.id), guild],
        guildData: { ...s.guildData, [g.id]: data },
      }));
      get().selectGuild(g.id);
    },

    async joinGuild(code) {
      const g = await api.post('/api/guilds/join', { code });
      const { guild, data } = splitGuild(g);
      set((s) => ({
        guilds: [...s.guilds.filter((x) => x.id !== g.id), guild],
        guildData: { ...s.guildData, [g.id]: data },
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
    /** Renomeia um canal. */
    async updateChannel(channelId, name) {
      get()._upsertChannel(await api.patch(`/api/channels/${channelId}`, { name }));
    },
    /** Canal privado (só `users`, o dono e os admins veem) ou público. */
    async setChannelAccess(channelId, isPrivate, users) {
      await api.put(`/api/channels/${channelId}/access`, { private: isPrivate, users });
      const guildId = Object.entries(get().guildData).find(([, g]) => g.channels.some((c) => c.id === channelId))?.[0];
      if (guildId) await get().loadGuild(guildId);
    },
    _upsertChannel(ch) {
      set((s) => {
        const g = s.guildData[ch.guildId];
        if (!g) return {};
        const channels = g.channels.some((c) => c.id === ch.id)
          ? g.channels.map((c) => (c.id === ch.id ? { ...c, ...ch } : c))
          : [...g.channels, ch];
        return { guildData: { ...s.guildData, [ch.guildId]: { ...g, channels } } };
      });
    },
    /**
     * Permissões personalizadas de um membro (bits de PERM). `custom = false` tira a pessoa da lista:
     * ela volta a ter as permissões padrão do servidor.
     */
    async setMemberPerms(guildId, userId, perms, custom = true) {
      const res = await api.patch(`/api/guilds/${guildId}/members/${userId}`, { perms, custom });
      get()._applyPerms(guildId, userId, res.perms, res.custom);
    },
    _applyPerms(guildId, userId, perms, custom = true) {
      set((s) => {
        const g = s.guildData[guildId];
        if (!g) return {};
        const next = { ...(g.perms || {}) };
        if (custom) next[userId] = perms;
        else delete next[userId];
        return { guildData: { ...s.guildData, [guildId]: { ...g, perms: next } } };
      });
    },
    /** O que avisar neste servidor (vale também para as notificações push). */
    async setGuildNotify(guildId, settings) {
      const saved = await api.put(`/api/guilds/${guildId}/notify`, settings);
      set((s) => ({ guildNotify: { ...s.guildNotify, [guildId]: saved } }));
    },
    /** Recebi as mensagens até `at` (vira ✓✓ para quem mandou). */
    markReceived(channelId, at) {
      const mark = (marks.get(channelId) || { delivered: 0, read: 0 });
      if (at <= mark.delivered) return;
      mark.delivered = at;
      marks.set(channelId, mark);
      flushMarks(channelId);
    },
    /** Li a conversa até a última mensagem (vira o olho para quem mandou, se eu deixar). */
    markRead(channelId) {
      const list = get().messages[channelId];
      const last = list && [...list].reverse().find((m) => !m.notice && m.author.id !== get().me?.id);
      if (!last) return;
      const mark = marks.get(channelId) || { delivered: 0, read: 0 };
      const sendRead = prefs().receipts?.sendRead !== false;
      if (last.createdAt <= mark.delivered && (!sendRead || last.createdAt <= mark.read)) return;
      mark.delivered = Math.max(mark.delivered, last.createdAt);
      if (sendRead) mark.read = Math.max(mark.read, last.createdAt);
      marks.set(channelId, mark);
      flushMarks(channelId);
    },
    /** Moderação de voz: `mute`, `unmute`, `disconnect` ou `move` (com `channelId`). */
    async moderateVoice(peerId, action, channelId) {
      const res = await rt?.request('voice:moderate', { peerId, action, channelId });
      if (!res || res.error) notify(res?.error || 'Sem conexão');
    },
    /** Silenciar alguém só para mim (vale em todas as chamadas). */
    toggleLocalMute(userId) {
      const cur = { ...(prefs().localMutes || {}) };
      if (cur[userId]) delete cur[userId];
      else cur[userId] = true;
      get().setAppearance({ localMutes: cur });
      for (const c of connRegistry.values()) c.getState()._applyLocalMutes();
    },
    _applyLocalMutes() {
      voiceClient?.setLocalMutes(Object.keys(prefs().localMutes || {}));
    },
    /** Fundo da tela de início (só eu vejo). `blob` já redimensionado; null tira. */
    async setMyBackground(blob) {
      const res = blob ? await api.put('/api/me/background', blob) : await api.del('/api/me/background');
      set({ myBackground: res?.url || null });
    },
    /** Fundo do servidor (administradores). */
    async setGuildBackground(guildId, blob) {
      get().applyGuild(blob ? await api.put(`/api/guilds/${guildId}/background`, blob) : await api.del(`/api/guilds/${guildId}/background`));
    },
    /** Registro do servidor com filtros (`kind`, `user`, `channel`, `q`, `before`, `since`). */
    guildLog(guildId, params = {}) {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
      return api.get(`/api/guilds/${guildId}/log${q ? `?${q}` : ''}`);
    },
    /** Validade de um arquivo: ms a partir de agora, ou null (não expira). */
    setFileTtl: (fileId, ttlMs) => api.patch(`/api/files/${fileId}`, { ttlMs }),
    /** Aparecer (ou não) para quem está na mesma rede. */
    lanHello() {
      if (kind !== 'server') return;
      rt?.send('lan:hello', { visible: prefs().nearbyVisible !== false, device: deviceLabel() });
      if (prefs().nearbyVisible === false) {
        probe.update([], myPeerId);
        set({ nearby: [], nearbyOk: {} });
      }
    },
    /** Código de convite (só para quem pode convidar). */
    async fetchInvite(guildId) {
      const { code } = await api.get(`/api/guilds/${guildId}/invite`);
      set((s) => ({ guilds: s.guilds.map((g) => (g.id === guildId ? { ...g, inviteCode: code } : g)) }));
      return code;
    },

    // ---------- Mensagens ----------
    /** `replyTo`: id da mensagem respondida (aparece citada acima da resposta). */
    async sendMessage(channelId, content, replyTo) {
      const res = await rt?.request('message:send', replyTo ? { channelId, content, replyTo } : { channelId, content });
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
    /** Reage com um emoticon (`on` = false tira a reação). */
    async reactMessage(messageId, emoji, on = true) {
      const res = await rt?.request('message:react', { messageId, emoji, on });
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
        iceServers: get().iceServers || get().config?.iceServers || [],
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
      globalThis.__padospeakVoice = client; // diagnóstico pelo DevTools
      const isDm = get().dms.some((d) => d.id === channelId);
      if (!isDm && primary) {
        set({ view: { type: 'voice', channelId } });
        openPane();
      }
      try {
        const { selfMuted, selfDeafened } = ui().getState();
        const p = prefs();
        client.setLocalMutes(Object.keys(p.localMutes || {}));
        await client.join(channelId, {
          muted: selfMuted,
          deafened: selfDeafened,
          devices: p.devices,
          noiseSuppression: p.noiseSuppression !== false,
          watch: watchPrefs(p),
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
      if (!voiceClient.screen && !navigator.mediaDevices?.getDisplayMedia)
        return notify(
          /iPhone|iPad|iPod/.test(navigator.userAgent)
            ? 'O iPhone e o iPad não deixam apps da web compartilharem a tela. Use o PadoSpeak no computador para transmitir (assistir funciona normalmente).'
            : 'Este navegador não oferece compartilhar a tela. No Android, use o Chrome atualizado; no computador, o Chrome, o Edge ou o app PadoSpeak.',
          'info',
        );
      try {
        await voiceClient.setScreen(!voiceClient.screen, preset);
      } catch (e) {
        if (e.name !== 'NotAllowedError') notify(`Compartilhamento de tela: ${e.message}`);
      }
    },
    setScreenPreset: (preset) => voiceClient?.setScreenPreset(preset),
    setPeerVolume: (peerId, v) => voiceClient?.setPeerVolume(peerId, v),
    /** Assistir (ou parar de assistir) a câmera ou a transmissão de alguém da chamada. */
    watchPeer: (peerId, kind, on) => voiceClient?.watch(peerId, kind, on),
    setStreamAudio: (peerId, opts) => voiceClient?.setStreamAudio(peerId, opts),
    setScreenAudioMuted: (muted) => voiceClient?.setScreenAudioMuted(muted),
    diagnostics: () => voiceClient?.diagnostics() || 'Fora de chamada.',
    /** Conta a esta conexão o jogo em foco (o app do Windows detecta; veja lib/activity.js). */
    _sendActivity() {
      if (rt?.status !== 'connected') return;
      const mine = prefs().shareActivity === false ? null : myActivity;
      rt.send('activity:set', { activity: mine });
      const me = get().me?.id;
      if (me) set((st) => ({ activities: { ...st.activities, [me]: mine || undefined } }));
    },
    latencyHistory: () => voiceClient?.latencyHistory() || { samples: [], series: [] },

    // ---------- Música ----------
    toggleMusicPanel: () =>
      ui().setState((s) =>
        s.sidebarView === 'music' ? { sidebarView: 'channels', mobilePane: 'list' } : { sidebarView: 'music', mobilePane: 'detail' },
      ),
    /**
     * Botão Início: vindo de um servidor, volta para a conversa que estava aberta no Início; já no
     * Início, vai para a página de amigos.
     */
    homeButton() {
      const s = ui().getState();
      const last = s.lastHomeView;
      if (s.currentGuildId != null && last?.type === 'dm') {
        const conn = getConn(last.conn);
        if (conn.getState().dms.some((d) => d.id === last.channelId)) return conn.getState().selectDm(last.channelId);
      }
      s.goHome();
    },
    /** Clicar em quem está transmitindo: entra no canal de voz (se preciso) e destaca a tela da pessoa. */
    async watchStream(channelId, userId) {
      ui().setState({ focusRequest: { userId, at: Date.now() } });
      if (get().voice?.channelId === channelId) get().showVoice();
      else await get().joinVoice(channelId);
    },
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

    /** Favoritas (minhas) e "Mais tocadas" do servidor nas últimas 2 semanas. */
    async loadMusicLibrary(guildId) {
      const res = await rt?.request('music:library', { guildId });
      if (res && !res.error) set({ musicLibrary: { guildId, favorites: res.favorites, top: res.top } });
    },
    /** Marca/desmarca uma música como favorita. */
    async toggleFavorite(track, on) {
      const { title, artist, pageUrl, thumbnail, durationMs } = track;
      const res = await rt?.request('music:favorite', { track: { title, artist, pageUrl, thumbnail, durationMs }, on });
      if (!res || res.error) return notify(res?.error || 'Sem conexão');
      set((s) => ({ musicLibrary: { ...s.musicLibrary, favorites: res.favorites } }));
    },

    async musicControl(op, trackId) {
      const res = await rt?.request(`music:${op}`, trackId ? { trackId } : {});
      if (res?.error) notify(res.error);
    },

    setMusicVolume(v) {
      get().setAppearance({ musicVolume: v });
    },

    /** Preferências de vídeo sob demanda (valem para as próximas pessoas/chamadas). */
    setWatchPrefs(patch) {
      get().setAppearance(patch);
      for (const c of connRegistry.values()) c.getState()._applyWatchPrefs();
    },
    _applyWatchPrefs() {
      if (voiceClient) Object.assign(voiceClient.watchPrefs, watchPrefs(prefs()));
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
    /** Link de um arquivo enviado na conversa (imagens e vídeos não mandam cabeçalho: o token vai na URL). */
    fileUrl: (id, download = false) =>
      `${baseUrl}/api/files/${id}?token=${encodeURIComponent(token || '')}${download ? '&download=1' : ''}`,
    /**
     * Envia um arquivo para a conversa/canal e devolve { id, name, mime, size }. `onProgress(0..1)`.
     * Usa XHR para acompanhar o envio (o fetch não informa o progresso do upload).
     */
    async uploadFile(channelId, file, onProgress, { kind: fileKind, nsfw } = {}) {
      // Texto, documentos e afins vão comprimidos (gzip); o servidor guarda assim e o download volta
      // com Content-Encoding: gzip, que o navegador descomprime sozinho. Arquivo acima do limite
      // normal (grande, some em 10 min) vai como está.
      const maxFile = get().config?.files?.maxFile;
      const packed = fileKind || (maxFile && file.size > maxFile) ? null : await gzipIfWorth(file);
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
          'POST',
          `${baseUrl}/api/files?channel=${encodeURIComponent(channelId)}&name=${encodeURIComponent(file.name)}${packed ? '&encoding=gzip' : ''}${fileKind ? `&kind=${fileKind}` : ''}${nsfw ? '&nsfw=1' : ''}`,
        );
        if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
        xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
        xhr.onload = () => {
          let data = null;
          try {
            data = JSON.parse(xhr.responseText);
          } catch {
            /* sem corpo */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else
            reject(
              new Error(
                data?.error || (xhr.status === 413 ? 'Arquivo grande demais para este servidor' : `Erro ${xhr.status}`),
              ),
            );
        };
        xhr.onerror = () => reject(new Error(`Não foi possível enviar para ${baseUrl}`));
        xhr.send(packed || file);
      });
    },
    deleteFile: (id) => api.del(`/api/files/${id}`),
    guildFiles: (guildId) => api.get(`/api/guilds/${guildId}/files`),
    /** Configuração do servidor (dono): nome e ícone. */
    async updateGuild(guildId, patch) {
      get().applyGuild(await api.patch(`/api/guilds/${guildId}`, patch));
    },
    async uploadGuildIcon(guildId, blob) {
      get().applyGuild(await api.put(`/api/guilds/${guildId}/icon`, blob));
    },
    async removeGuildIcon(guildId) {
      get().applyGuild(await api.del(`/api/guilds/${guildId}/icon`));
    },
    applyGuild(g) {
      if (!g) return;
      set((s) => ({
        // O código de convite não vem nos avisos para todos: mantém o que já tinha.
        guilds: s.guilds.map((x) => (x.id === g.id ? { ...x, ...g, inviteCode: g.inviteCode || x.inviteCode } : x)),
        guildData: s.guildData[g.id] ? { ...s.guildData, [g.id]: { ...s.guildData[g.id], ...g } } : s.guildData,
      }));
    },
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
  const channel = q.get('channel');
  if (!dm && !friends && !channel) return;
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
    ui.goHome();
    ui.setMobileTab('friends');
  } else if (channel) {
    const guildId = Object.entries(ui.guildData).find(([, g]) => g.channels.some((c) => c.id === channel))?.[0];
    if (guildId)
      ui.selectGuild(guildId).then(() => {
        useStore.getState().selectTextChannel(channel);
      });
  }
}

/**
 * Celular e tablet: o "voltar" do sistema (Android e app instalado) volta uma tela — fecha a janela
 * aberta ou sai da conversa — em vez de sair do PadoSpeak. Cada tela por cima vira uma entrada no
 * histórico do navegador, e o histórico acompanha quando ela é fechada pelos botões do app.
 */
export function initBackNavigation() {
  let depth = 0; // entradas que o app colocou no histórico
  let expectPop = false; // o próprio app voltou o histórico (não é o botão do sistema)
  let applying = false;
  const layers = (s) =>
    currentLayout() === 'desktop' ? 0 : (s.mobilePane === 'detail' && currentLayout() === 'phone' ? 1 : 0) + (s.modal ? 1 : 0);
  useStore.subscribe((s) => {
    if (applying) return;
    const want = layers(s);
    if (want > depth) {
      for (; depth < want; depth++) history.pushState({ padospeak: depth + 1 }, '');
    } else if (want < depth) {
      expectPop = true;
      history.go(want - depth);
      depth = want;
    }
  });
  window.addEventListener('popstate', () => {
    if (expectPop) {
      expectPop = false;
      return;
    }
    if (depth === 0) return;
    depth -= 1;
    applying = true;
    const s = useStore.getState();
    if (s.modal) s.closeModal();
    else if (s.mobilePane === 'detail') s.mobileBack();
    applying = false;
  });
}

/** Voltou para a janela: a conversa que está aberta foi lida (some o número vermelho). */
function markViewedRead() {
  const v = useStore.getState().view;
  if (v?.type !== 'dm' || !appHasFocus()) return;
  const store = getConn(v.conn);
  if (store.getState().unread[v.channelId]) store.setState((s) => ({ unread: { ...s.unread, [v.channelId]: 0 } }));
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const visible = document.visibilityState === 'visible';
    for (const c of connRegistry.values()) c.getState().sendVisibility(visible);
    if (visible && appHasFocus()) markViewedRead();
  });
  window.addEventListener('focus', markViewedRead);
  // App do Windows: a janela voltou ao foco (aviso do Tauri; o WebView nem sempre dispara "focus").
  window.addEventListener('padospeak:focus', markViewedRead);
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

// Atalhos de silenciar/ensurdecer (globais no app do Windows), refeitos quando a pessoa muda nas Configurações.
if (!isPanel) {
  const hotkeyActions = {
    mute: () => {
      useStore.getState().toggleMute();
      playSound(useStore.getState().selfMuted ? 'muteOn' : 'muteOff');
    },
    deafen: () => {
      useStore.getState().toggleDeafen();
      playSound(useStore.getState().selfDeafened ? 'muteOn' : 'muteOff');
    },
  };
  applyHotkeys(hotkeysOf(useStore.getState().prefs), hotkeyActions);
  useStore.subscribe((s, prev) => {
    if (s.prefs.hotkeys !== prev.prefs.hotkeys) applyHotkeys(hotkeysOf(s.prefs), hotkeyActions);
  });
}

// App desktop: o perfil mudou no servidor (editado no site, no celular…) → a cópia local acompanha.
if (isDesktop) {
  let pullTimer;
  useStore.subscribe((s, prev) => {
    if (!s.me || !prev.me || s.me === prev.me || s.me.id !== prev.me.id) return;
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => pullProfileFrom(useStore), 400);
  });
}

// Ao sair do Início para um servidor, lembra o que estava aberto (o botão Início volta para lá).
useStore.subscribe((s, prev) => {
  if (prev.currentGuildId == null && s.currentGuildId != null && prev.view) useStore.setState({ lastHomeView: prev.view });
});

/** Vídeo sob demanda: o que abrir sozinho ao entrar numa chamada (por padrão só a câmera em chamada direta). */
const watchPrefs = (p) => ({
  camera: Boolean(p.autoWatchCamera),
  screen: Boolean(p.autoWatchScreen),
  dmCamera: p.autoWatchDmCamera !== false,
});

/** Onde o app está aberto: app do Windows, app instalado (PWA) ou navegador; aparelho e sistema. */
function appPlatform() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '';
  const layout = currentLayout();
  const device = isTauri ? 'computador' : isTouch ? (layout === 'phone' ? 'celular' : 'tablet') : 'computador';
  return { platform: isTauri ? 'app' : isStandalone ? 'pwa' : 'navegador', device, os };
}

/** Formatos que já vêm comprimidos (imagem, vídeo, áudio, compactados, Office): não vale comprimir. */
const PACKED_EXT =
  /\.(zip|rar|7z|gz|tgz|bz2|xz|zst|docx|xlsx|pptx|odt|ods|odp|epub|jar|apk|png|jpe?g|gif|webp|avif|heic|mp3|mp4|m4a|aac|ogg|opus|webm|mkv|mov|avi|flac|woff2?)$/i;

/** Comprime o arquivo em gzip antes do envio, se o navegador souber e se economizar pelo menos 10%. */
async function gzipIfWorth(file) {
  if (typeof CompressionStream === 'undefined' || file.size < 2048 || file.size > 200 * 1024 * 1024) return null;
  if (/^(image|video|audio)\//.test(file.type) || PACKED_EXT.test(file.name)) return null;
  try {
    const blob = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    return blob.size * 10 < file.size * 9 ? blob : null;
  } catch {
    return null;
  }
}

/** Bits de permissão dentro de um servidor (iguais aos do servidor). */
export const PERM = { ADMIN: 1, INVITE: 2, CHANNELS: 4, MUTE: 8, DISCONNECT: 16, MOVE: 32 };
const ALL_PERMS = 63;

/** Bits de um membro: os da lista personalizada, ou o padrão do servidor. */
export function memberBits(s, guildId, userId) {
  const guild = s.guilds.find((g) => g.id === guildId);
  if (guild && guild.ownerId === userId) return ALL_PERMS;
  const custom = s.guildData[guildId]?.perms?.[userId];
  return custom ?? guild?.defaultPerms ?? PERM.INVITE;
}

/** O que eu posso fazer num servidor: dono e admin podem tudo. */
export function permsOf(s, guildId) {
  const guild = s.guilds.find((g) => g.id === guildId);
  const owner = Boolean(guild && s.me && guild.ownerId === s.me.id);
  const bits = s.me ? memberBits(s, guildId, s.me.id) : 0;
  return permFlags(owner, bits);
}

const permFlags = (owner, bits) => {
  const admin = owner || (bits & PERM.ADMIN) !== 0;
  const has = (b) => admin || (bits & b) !== 0;
  return {
    owner,
    admin,
    invite: has(PERM.INVITE),
    channels: has(PERM.CHANNELS),
    mute: has(PERM.MUTE),
    disconnect: has(PERM.DISCONNECT),
    move: has(PERM.MOVE),
  };
};

/** Hook: minhas permissões no servidor, a partir de um store de conexão (`useStore` ou `useConn()`). */
export function usePerms(useC, guildId) {
  const owner = useC((s) => Boolean(s.me && s.guilds.find((g) => g.id === guildId)?.ownerId === s.me.id));
  const bits = useC((s) => (s.me ? memberBits(s, guildId, s.me.id) : 0));
  return permFlags(owner, bits);
}

/** Separa a resposta de /api/guilds/{id} em dados do servidor e o resto (canais, membros, permissões). */
function splitGuild(full) {
  const { channels, members, perms = {}, channelAccess = {}, ...guild } = full;
  return { guild, data: { channels, members, perms, channelAccess } };
}

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
  syncProfileEverywhere: () => syncProfileEverywhere(),
  setMyActivity: (a) => setMyActivity(a),
  NearbyProbe,
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

/**
 * App desktop, senha do perfil local esquecida: confere usuário e senha (ou o código de redefinição) no
 * servidor de comunidade. Devolve `{ needsNew: true }` se for o código (falta escolher a senha nova);
 * senão entra, com o perfil local já usando a senha do servidor. Senha errada lá também: `{ wrong }`.
 */
export async function localRecover({ username, password, newPassword }) {
  const local = connRegistry.get('local');
  const server = useStore.getState().baseUrl;
  if (!local || !server) return null;
  const remote = createApi(
    () => server,
    () => null,
  );
  let res;
  try {
    res = newPassword
      ? await remote.post('/api/auth/new-password', { username, password, newPassword })
      : await remote.post('/api/auth/login', { username, password });
  } catch (e) {
    if (e instanceof ApiError && e.status === 428) return { needsNew: true };
    if (e instanceof ApiError && e.status === 401 && !newPassword) return { wrong: e };
    throw e;
  }
  const finalPassword = newPassword || password;
  const done = await createApi(
    () => local.getState().baseUrl,
    () => null,
  ).post('/api/auth/recover', { username, newPassword: finalPassword, server, token: res.token });
  localPassword = finalPassword;
  await enterLocal(local, done.user, finalPassword, done.token);
  return { ok: true };
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
        await pullProfileFrom(useStore);
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
      await pullProfileFrom(useStore);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return useStore.setState({ serverStatus: 'mismatch' });
      // Senha redefinida no servidor: a pessoa entra pela janela de login e cria a senha nova.
      if (e instanceof ApiError && e.status === 428) return useStore.setState({ serverStatus: 'login' });
      throw e;
    }
  } catch {
    useStore.setState({ serverStatus: 'unreachable' });
    serverRetry = setTimeout(() => {
      if (useStore.getState().serverStatus === 'unreachable') connectServer({ username, password });
    }, SERVER_RETRY_MS);
  }
}

/**
 * Entra no servidor com outra conta (ou cria uma), pela janela de login do servidor. Conta que já
 * existia: o perfil dela vale também neste PC. Conta recém-criada: começa com o perfil deste PC.
 */
export async function serverAuthenticate(mode, form) {
  clearTimeout(serverRetry);
  await useStore.getState().authenticate(mode, form);
  if (mode === 'register') await syncProfileTo(useStore);
  else await pullProfileFrom(useStore);
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

const PROFILE_KEYS = ['displayName', 'bio', 'nameColor', 'bioColor', 'bannerColor', 'messageColor'];

/**
 * O servidor de comunidade manda no perfil: ao conectar (mesmo usuário), nome, mensagem pessoal, cores
 * e foto de lá passam para o perfil local, que é só uma cópia para entrar sem internet. Depois a cópia
 * segue para os PCs da rede.
 */
export async function pullProfileFrom(target) {
  const local = connRegistry.get('local');
  const mine = local?.getState().me;
  const theirs = target.getState().me;
  if (!mine || !theirs || target === local) return;
  if (theirs.username.toLowerCase() !== mine.username.toLowerCase()) return;
  try {
    const patch = {};
    for (const k of PROFILE_KEYS) if ((mine[k] || '') !== (theirs[k] || '')) patch[k] = theirs[k] || '';
    if (Object.keys(patch).length) await local.getState().updateProfile(patch);
    // Foto: só baixa de novo quando a do servidor mudou (a URL leva a versão).
    const base = target.getState().baseUrl;
    const pulledKey = `padospeak.avatarPull:${base}#${theirs.id}`;
    const want = theirs.avatarUrl || '';
    const hasLocal = Boolean(local.getState().me?.avatarUrl);
    if (want !== storage.get(pulledKey) || Boolean(want) !== hasLocal) {
      if (want) {
        const blob = await target.getState().avatarBlob();
        if (blob) await local.getState().uploadAvatar(blob);
      } else if (hasLocal) await local.getState().removeAvatar();
      storage.set(pulledKey, want);
      // A foto local agora é a do servidor: não precisa mandar de volta.
      storage.set(`padospeak.avatarSync:${base}#${theirs.id}`, local.getState().me?.avatarUrl || '');
    }
    for (const [key, store] of connRegistry) if (key.startsWith('peer:')) syncProfileTo(store);
  } catch (e) {
    console.warn('[perfil] cópia do servidor', e);
  }
}

/**
 * Leva o perfil local para outra conexão (mesmo usuário): os PCs da rede, e o servidor de comunidade
 * logo depois de a pessoa editar o perfil (ou ao criar a conta lá pelo app).
 */
export async function syncProfileTo(target) {
  const local = connRegistry.get('local');
  const mine = local?.getState().me;
  const theirs = target.getState().me;
  if (!mine || !theirs || target === local) return;
  if (target.getState().kind === 'server' && theirs.username.toLowerCase() !== mine.username.toLowerCase()) return;
  try {
    const patch = {};
    for (const k of PROFILE_KEYS) if ((mine[k] || '') !== (theirs[k] || '')) patch[k] = mine[k] || '';
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
      // A foto que acabou de ir para o servidor já é a do perfil local: não precisa baixar de volta.
      if (target.getState().kind === 'server') storage.set(`padospeak.avatarPull:${target.getState().baseUrl}#${theirs.id}`, target.getState().me?.avatarUrl || '');
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
/**
 * Envia um arquivo numa conversa/canal: sobe para o servidor da conversa e manda a mensagem
 * `[arquivo:<id>:<tamanho>:<tipo>:<nome>]`. Programas e scripts só dentro de um .zip.
 * Marcado como NSFW (`nsfw`), o tipo vai como `nsfw;<tipo>` e o arquivo aparece borrado até clicar
 * (versões antigas do app mostram só o cartão do arquivo, sem a imagem).
 */
export const FILE_RE = /^\[arquivo:([0-9a-f]{32}):(\d+):([^:\]]*):([^\]]*)\](?:\n([\s\S]*))?$/;
export const NSFW_PREFIX = 'nsfw;';
/** `caption`: texto que vai junto, na mesma mensagem (linha de baixo). */
const withCaption = (tag, caption) => (caption?.trim() ? `${tag}\n${caption.trim()}` : tag);
export async function sendFile(connKey, channelId, file, { onProgress, replyTo, caption, nsfw } = {}) {
  const target = getConn(connKey);
  const info = await target.getState().uploadFile(channelId, file, onProgress, { nsfw });
  const name = info.name.replace(/[\]\n:]/g, '_');
  const mime = nsfw ? `${NSFW_PREFIX}${info.mime}` : info.mime;
  return target.getState().sendMessage(channelId, withCaption(`[arquivo:${info.id}:${info.size}:${mime}:${name}]`, caption), replyTo);
}

/** Mensagem de voz gravada no app (`blob` de áudio, `durationMs`). */
export async function sendVoice(connKey, channelId, blob, durationMs, { onProgress, replyTo } = {}) {
  const target = getConn(connKey);
  const ext = /mp4|aac/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'weba';
  const file = new File([blob], `mensagem-de-voz.${ext}`, { type: blob.type || 'audio/webm' });
  const info = await target.getState().uploadFile(channelId, file, onProgress, { kind: 'voice' });
  return target.getState().sendMessage(channelId, `[voz:${info.id}:${Math.round(durationMs)}:${info.mime}]`, replyTo);
}

export async function sendSticker(connKey, channelId, sticker, { caption, replyTo } = {}) {
  const target = getConn(connKey);
  try {
    if (sticker.emote)
      return await target.getState().sendMessage(channelId, withCaption(`[sticker:emote:${sticker.emote}]`, caption), replyTo);
    const home = stickerHome();
    let id = sticker.id;
    if (home !== target) {
      const blob = await home.getState().stickerBlob(sticker.id);
      id = (await target.getState().uploadSticker(blob, sticker.name)).id;
    }
    return await target.getState().sendMessage(channelId, withCaption(`[sticker:${id}]`, caption), replyTo);
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
