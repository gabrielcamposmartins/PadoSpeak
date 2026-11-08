// Gestos da câmera na chamada: tira um quadro pequeno da própria câmera de vez em quando, manda para o worker do
// MediaPipe (`gesture.worker.js`) e passa o resultado pelo filtro (`debounce.js`). Feito para pesar pouco:
// - um quadro por vez, em 224–320 px de largura;
// - devagar sem mão na imagem (3 por segundo) e mais rápido com ela (10 no PC, 6–7 no celular);
// - desacelera sozinho se o aparelho não acompanhar, e desliga com aviso se ficar lento demais;
// - para com a aba oculta, a câmera desligada ou a chamada no fim; o worker fecha 30 s depois.
import { createGestureFilter } from './debounce.js';
import { loadAssets } from '../models.js';

const SLOW_MS = 333;
const FAST_MS = 100;
const FAST_PHONE_MS = 150;
const MAX_MS = 1000;
const HAND_KEEP_MS = 2000;
const TOO_SLOW_MS = 250;
const TOO_SLOW_FOR_MS = 10_000;
const IDLE_CLOSE_MS = 30_000;
const DELEGATE_KEY = 'padospeak.gestureDelegate';
/** Escolha do caminho: quadros medidos em cada um (os 2 primeiros aquecem) e o limite para testar o outro. */
const PROBE_FRAMES = 6;
const PROBE_SLOW_MS = 40;

const phone = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const storage = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export class GestureController {
  /** `onGesture(nome)`, `onStatus({ loading, ready, error })`, `onNotice(texto)`. */
  constructor({ onGesture, onStatus, onNotice }) {
    this.onGesture = onGesture;
    this.onStatus = onStatus;
    this.onNotice = onNotice;
    this.filter = createGestureFilter();
    this.video = null;
    this.track = null;
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.timer = null;
    this.closeTimer = null;
    this.interval = SLOW_MS;
    this.lastHand = 0;
    this.ewma = 0;
    this.slowSince = 0;
    this.width = 256;
    this.running = false;
    this.loading = null;
    this.metrics = { ewmaMs: 0, fps: 0, delegate: null, frames: 0 };
    this.frameTimes = [];
  }

  /** Liga (ou troca a trilha) com a câmera desta chamada. */
  async start(stream) {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return this.stop();
    clearTimeout(this.closeTimer);
    if (!this.video) {
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
    }
    if (this.track !== track) {
      this.track = track;
      this.video.srcObject = new MediaStream([track]);
      this.video.play().catch(() => {});
    }
    this.running = true;
    if (!this.worker && !this.loading) this.loading = this.boot(storage.get(DELEGATE_KEY)).finally(() => (this.loading = null));
    if (!this.timer) this.schedule(0);
  }

  /**
   * Abre o worker com o caminho pedido (`GPU`, `CPU` ou nada = placa de vídeo, testando). Sem escolha guardada neste
   * aparelho, mede a placa de vídeo e, se ela for lenta, abre outro worker com o processador e fica com o mais rápido.
   */
  async boot(delegate) {
    try {
      if (!this.files) {
        this.onStatus?.({ loading: 0 });
        const files = await loadAssets(['mp-vision-loader', 'mp-vision-wasm', 'mp-gesture-task'], (f) => this.onStatus?.({ loading: f }));
        this.files = {
          loaderUrl: URL.createObjectURL(new Blob([files['mp-vision-loader']], { type: 'text/javascript' })),
          wasmUrl: URL.createObjectURL(new Blob([files['mp-vision-wasm']], { type: 'application/wasm' })),
          model: files['mp-gesture-task'],
        };
      }
      if (!this.running) return;
      this.probe = delegate ? null : { phase: 'GPU', times: [], gpuMs: 0 };
      this.chosen = Boolean(delegate);
      const worker = new Worker(new URL('./gesture.worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      this.ready = false;
      this.busy = false;
      worker.onmessage = ({ data }) => worker === this.worker && this.message(data);
      worker.onerror = (e) => {
        if (worker !== this.worker) return;
        this.onStatus?.({ error: e.message || 'erro no reconhecimento de gestos' });
        this.destroy();
      };
      const { loaderUrl, wasmUrl, model } = this.files;
      worker.postMessage({ type: 'init', loaderUrl, wasmUrl, model: model.slice(0), delegate: delegate || null });
    } catch (e) {
      this.onStatus?.({ error: e.message });
      this.onNotice?.(`Gestos da câmera: ${e.message}`);
      this.destroy();
    }
  }

  message(data) {
    if (data.type === 'ready') {
      this.ready = true;
      this.metrics.delegate = data.delegate;
      this.onStatus?.({ ready: true });
      return;
    }
    if (data.type === 'error') {
      this.onStatus?.({ error: data.message });
      this.onNotice?.('Não deu para ligar os gestos da câmera neste aparelho.');
      this.destroy();
      return;
    }
    if (data.type !== 'result') return;
    this.busy = false;
    if (this.probe && this.measure(data)) return;
    const now = performance.now();
    if (data.hand) this.lastHand = now;
    // tempo médio da inferência e o ritmo que o aparelho aguenta
    this.ewma = this.ewma ? this.ewma * 0.8 + data.ms * 0.2 : data.ms;
    this.metrics.ewmaMs = Math.round(this.ewma * 10) / 10;
    this.metrics.frames++;
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((t) => now - t < 2000);
    this.metrics.fps = Math.round((this.frameTimes.length / 2) * 10) / 10;
    // mão pequena na imagem: um pouco mais de resolução ajuda
    this.width = data.hand && data.size > 0 && data.size < 0.15 ? 320 : data.hand ? 256 : 224;
    const fast = now - this.lastHand < HAND_KEEP_MS;
    let next = fast ? (phone() ? FAST_PHONE_MS : FAST_MS) : SLOW_MS;
    while (this.ewma > next * 0.6 && next < MAX_MS) next = Math.min(MAX_MS, next * 1.5);
    this.interval = next;
    // só depois de escolher o caminho mais rápido (placa de vídeo ou processador)
    if (this.chosen && this.ewma > TOO_SLOW_MS) {
      this.slowSince ||= now;
      if (now - this.slowSince > TOO_SLOW_FOR_MS) {
        this.onNotice?.('Os gestos da câmera foram desligados: este aparelho está lento demais para eles.');
        this.onStatus?.({ error: 'lento demais', tooSlow: true });
        this.destroy();
        return;
      }
    } else this.slowSince = 0;
    this.metrics.last = { gesture: data.gesture, score: Math.round(data.score * 100) / 100, hand: data.hand };
    if (data.delegate) this.metrics.delegate = data.delegate;
    const fired = this.filter.push({ gesture: data.gesture, score: data.score, wrist: data.wrist }, now);
    if (fired) this.onGesture?.(fired);
  }

  /** Escolha do caminho (placa de vídeo × processador). `true` quando trocou de worker (o resultado é descartado). */
  measure(data) {
    const p = this.probe;
    if (data.delegate !== p.phase) {
      // a placa de vídeo não abriu e o worker já caiu no processador
      return this.decide(data.delegate);
    }
    p.times.push(data.ms);
    if (p.times.length < PROBE_FRAMES) return false;
    const avg = p.times.slice(2).reduce((a, b) => a + b, 0) / (p.times.length - 2);
    if (p.phase === 'GPU') {
      if (avg <= PROBE_SLOW_MS) return this.decide('GPU');
      // lenta: testa o processador num worker novo
      this.swap({ phase: 'CPU', times: [], gpuMs: avg }, 'CPU');
      return true;
    }
    if (avg <= p.gpuMs) return this.decide('CPU');
    this.decide('GPU');
    this.swap(null, 'GPU');
    return true;
  }

  decide(delegate) {
    storage.set(DELEGATE_KEY, delegate);
    this.metrics.delegate = delegate;
    this.probe = null;
    this.chosen = true;
    this.ewma = 0;
    this.slowSince = 0;
    return false;
  }

  swap(probe, delegate) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.ewma = 0;
    this.loading = this.boot(delegate).finally(() => (this.loading = null));
    // boot() começa sem medição quando recebe o caminho: aqui é para medir o processador
    this.loading.then(() => {
      if (probe) {
        this.probe = probe;
        this.chosen = false;
      }
    });
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    this.timer = null;
    if (!this.running) return;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const t = this.track;
    const live = t && t.readyState === 'live' && t.enabled && !t.muted;
    const v = this.video;
    if (!hidden && live && this.ready && !this.busy && v && v.readyState >= 2 && v.videoWidth) {
      try {
        const bitmap = await createImageBitmap(v, { resizeWidth: this.width, resizeHeight: Math.round((this.width * v.videoHeight) / v.videoWidth), resizeQuality: 'low' });
        if (this.worker && this.running) {
          this.busy = true;
          this.worker.postMessage({ type: 'frame', bitmap, ts: performance.now() }, [bitmap]);
        } else bitmap.close();
      } catch {
        this.busy = false;
      }
    }
    this.schedule(hidden ? MAX_MS : this.interval);
  }

  /** Para de olhar a câmera (o worker fica 30 s, para voltar rápido se a câmera religar). */
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.video) this.video.srcObject = null;
    this.track = null;
    clearTimeout(this.closeTimer);
    if (this.worker) this.closeTimer = setTimeout(() => this.destroy(), IDLE_CLOSE_MS);
  }

  /** Fecha tudo agora. */
  destroy() {
    this.stop();
    clearTimeout(this.closeTimer);
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.probe = null;
    // solta da memória o wasm e o modelo (voltam do IndexedDB na próxima vez)
    if (this.files) {
      URL.revokeObjectURL(this.files.loaderUrl);
      URL.revokeObjectURL(this.files.wasmUrl);
      this.files = null;
    }
  }

  /** Teste: passa quadros falsos do gesto pelo filtro (tudo menos o modelo). */
  simulate(gesture) {
    // filtro próprio: os tempos falsos não atrapalham o filtro da câmera de verdade
    const filter = createGestureFilter();
    const wave = gesture === 'wave';
    for (let i = 0; i <= 12; i++) {
      const t = i * 100;
      const fired = filter.push(
        { gesture: wave ? 'Open_Palm' : gesture, score: 0.95, wrist: { x: 0.5 + (wave ? 0.12 * Math.sin(i * 1.6) : 0), y: 0.5 } },
        t,
      );
      if (fired) {
        this.onGesture?.(fired);
        return fired;
      }
    }
    return null;
  }
}
