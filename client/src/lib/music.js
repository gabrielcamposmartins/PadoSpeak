// Toca a fila do canal de voz em sincronia com o relógio do servidor.
// Todos no canal usam o mesmo stream (proxy do servidor) na posição `agora − startedAt`.

/** Diferença tolerada entre a posição local e a do servidor antes de corrigir (segundos). */
const DRIFT_S = 0.75;

export class MusicPlayer {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.trackId = null;
    this.sinkId = '';
    this.opts = null;
    this.audio.addEventListener('loadedmetadata', () => this.sync());
    this.timer = setInterval(() => this.sync(), 1000);
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
    if (cur.pausedAt != null) a.pause();
    else if (a.paused) a.play().catch(() => {});
  }

  /** Posição atual da faixa (segundos), para a barra de progresso. */
  static position(state, serverNow) {
    const cur = state?.current;
    if (!cur || cur.startedAt == null) return 0;
    return Math.max(0, ((cur.pausedAt ?? serverNow) - cur.startedAt) / 1000);
  }
}
