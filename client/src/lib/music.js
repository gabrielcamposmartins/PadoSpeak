// Toca a fila do canal de voz em sincronia com o relógio do servidor.
// Todos no canal usam o mesmo stream (proxy do servidor) na posição `agora − startedAt`.

/** Diferença tolerada entre a posição local e a do servidor antes de corrigir (segundos). */
const DRIFT_S = 0.75;
/** Tentativas de recarregar o áudio de uma faixa que falhou (erro ou parado), com espera crescente. */
const MAX_RETRIES = 5;
/** Deveria estar tocando e a posição não anda há este tempo: recarrega. */
const STALL_MS = 10000;

export class MusicPlayer {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.trackId = null;
    this.sinkId = '';
    this.opts = null;
    this.retries = 0;
    this.audio.addEventListener('loadedmetadata', () => this.sync());
    // O áudio falhou (proxy fora, URL do YouTube recusada, conexão caiu no meio): tenta de novo, em vez de
    // ficar mudo até a próxima faixa.
    this.audio.addEventListener('error', () => this.retry());
    this.audio.addEventListener('playing', () => {
      this.retries = 0;
    });
    this.timer = setInterval(() => this.sync(), 1000);
  }

  /** Recarrega o áudio da faixa atual (e volta para a posição do servidor quando carregar). */
  retry() {
    const o = this.opts;
    const cur = o?.state?.current;
    if (!cur || cur.track.id !== this.trackId || this.retries >= MAX_RETRIES) return;
    clearTimeout(this.retryTimer);
    const id = cur.track.id;
    const wait = Math.min(8000, 1000 * 2 ** this.retries++);
    this.retryTimer = setTimeout(() => {
      if (this.trackId !== id) return;
      this.stallSince = Date.now();
      this.audio.src = `${o.streamUrl(id)}&retry=${Date.now()}`;
      this.sync();
    }, wait);
  }

  /** O navegador bloqueou o som sem um clique: toca no primeiro clique ou tecla. */
  waitGesture() {
    if (this.gesture) return;
    this.gesture = () => {
      document.removeEventListener('pointerdown', this.gesture, true);
      document.removeEventListener('keydown', this.gesture, true);
      this.gesture = null;
      this.sync();
    };
    document.addEventListener('pointerdown', this.gesture, true);
    document.addEventListener('keydown', this.gesture, true);
  }

  /**
   * @param {object} opts
   * @param {object|null} opts.state     estado `music:state` do canal em que estou (ou null)
   * @param {boolean} opts.muted         ensurdecido
   * @param {number} opts.volume         0–1
   * @param {string} opts.sinkId         saída de áudio escolhida
   * @param {(id: string) => string} opts.streamUrl
   * @param {() => number} opts.serverNow relógio do servidor (ms)
   */
  update(opts) {
    this.opts = opts;
    this.sync();
  }

  sync() {
    const o = this.opts;
    const a = this.audio;
    const cur = o?.state?.current;
    clearTimeout(this.startTimer);

    if (!cur) {
      if (this.trackId) {
        this.trackId = null;
        a.pause();
        a.removeAttribute('src');
        a.load();
      }
      return;
    }
    // Ainda carregando no servidor: só pede o stream quando a faixa estiver pronta.
    if (cur.startedAt == null) return a.pause();
    if (this.trackId !== cur.track.id) {
      this.trackId = cur.track.id;
      this.retries = 0;
      clearTimeout(this.retryTimer);
      this.stallSince = Date.now();
      this.lastTime = -1;
      a.src = o.streamUrl(cur.track.id);
    }
    a.volume = o.volume;
    a.muted = o.muted;
    if (a.setSinkId && o.sinkId !== this.sinkId) {
      this.sinkId = o.sinkId;
      a.setSinkId(o.sinkId).catch(() => {});
    }

    const target = ((cur.pausedAt ?? o.serverNow()) - cur.startedAt) / 1000;
    if (target < 0) {
      // Começa no instante combinado (o servidor dá uma folga para todos carregarem).
      a.pause();
      this.startTimer = setTimeout(() => this.sync(), -target * 1000 + 15);
      return;
    }
    if (a.readyState >= 1 && Math.abs(a.currentTime - target) > DRIFT_S) {
      if (!Number.isFinite(a.duration) || target < a.duration) a.currentTime = target;
    }
    if (cur.pausedAt != null) {
      a.pause();
      this.stallSince = Date.now();
      return;
    }
    if (a.paused) a.play().catch((e) => e?.name === 'NotAllowedError' && this.waitGesture());
    // Parado: deveria tocar, mas a posição não anda (o stream travou sem dar erro).
    const ends = Number.isFinite(a.duration) ? a.duration : cur.track.durationMs ? cur.track.durationMs / 1000 : Infinity;
    if (a.currentTime !== this.lastTime || this.gesture || target >= ends - 1) {
      this.lastTime = a.currentTime;
      this.stallSince = Date.now();
    } else if (Date.now() - this.stallSince > STALL_MS) {
      this.stallSince = Date.now();
      this.retry();
    }
  }

  /** Posição atual da faixa (segundos), para a barra de progresso. */
  static position(state, serverNow) {
    const cur = state?.current;
    if (!cur || cur.startedAt == null) return 0;
    return Math.max(0, ((cur.pausedAt ?? serverNow) - cur.startedAt) / 1000);
  }
}
