// Som da transmissão de tela no app do Windows: o próprio Windows captura (veja
// desktop/src-tauri/src/screen_audio.rs) e o áudio chega aqui em pedaços de 20 ms (PCM 16 bits, 48 kHz,
// estéreo). Um AudioWorklet toca esses pedaços numa trilha que vai junto com o vídeo da tela.
// - Janela escolhida → só o som daquele programa.
// - Tela inteira → o som do sistema menos o do PadoSpeak (quem assiste não ouve a própria voz de volta).
import { isTauri } from './env.js';

const WORKLET = `
class PcmFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2); // 1 s estéreo intercalado
    this.read = 0;
    this.size = 0;
    this.started = false;
    this.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      const cap = this.buf.length;
      // Atrasou demais (aba em segundo plano, por exemplo): descarta o mais antigo e fica perto de 60 ms.
      if (this.size + pcm.length > cap * 0.3) {
        const drop = Math.min(this.size, this.size + pcm.length - 5760);
        this.read = (this.read + drop) % cap;
        this.size -= drop;
      }
      let w = (this.read + this.size) % cap;
      for (let i = 0; i < pcm.length; i++) {
        this.buf[w] = pcm[i] / 32768;
        w = w + 1 === cap ? 0 : w + 1;
      }
      this.size += pcm.length;
    };
  }
  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    const cap = this.buf.length;
    // Começa com 40 ms guardados, para não picotar quando um pedaço atrasa um pouco.
    if (!this.started) {
      if (this.size < 3840) return true;
      this.started = true;
    }
    for (let i = 0; i < l.length; i++) {
      if (this.size >= 2) {
        l[i] = this.buf[this.read];
        r[i] = this.buf[this.read + 1];
        this.read = (this.read + 2) % cap;
        this.size -= 2;
      } else {
        l[i] = r[i] = 0;
        this.started = false;
      }
    }
    return true;
  }
}
registerProcessor('pcm-feed', PcmFeed);
`;

/** Janela escolhida no seletor do navegador ("window:<HWND>:0" no rótulo da trilha), ou null. */
export function pickedWindow(videoTrack) {
  const ids = [videoTrack?.label, videoTrack?.getSettings?.().deviceId];
  for (const id of ids) {
    const m = /^window:(\d+):/.exec(id || '');
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Começa a captura do Windows para a tela/janela de `videoTrack`. Devolve `{ track, mode, source, stop }`
 * ou lança um erro (Windows antigo, janela fechada…).
 */
export async function startNativeScreenAudio(videoTrack) {
  if (!isTauri) throw new Error('Só no app do Windows');
  const surface = videoTrack.getSettings?.().displaySurface;
  const hwnd = surface === 'monitor' ? null : pickedWindow(videoTrack);
  // Sem o HWND no rótulo, o rótulo costuma ser o título da janela: o Windows procura por ele.
  const label = videoTrack.label || '';
  const title = surface !== 'monitor' && hwnd == null && !/^(screen|window|web-contents-media-stream):/.test(label) ? label : null;
  const ctx = new AudioContext({ sampleRate: 48000 });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, 'pcm-feed', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const channel = new Channel();
  channel.onmessage = (data) => {
    const buf = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    node.port.postMessage(buf, [buf]);
  };
  let info;
  try {
    info = await invoke('screen_audio_start', { hwnd, title, onData: channel });
  } catch (e) {
    ctx.close().catch(() => {});
    throw new Error(String(e));
  }
  ctx.resume().catch(() => {});
  const [track] = dest.stream.getAudioTracks();
  return {
    track,
    mode: info.mode,
    source: info.source,
    // Janela que não foi reconhecida: caiu no som do sistema (sem o PadoSpeak).
    fallback: surface !== 'monitor' && info.mode !== 'window',
    stop() {
      invoke('screen_audio_stop').catch(() => {});
      track.stop();
      ctx.close().catch(() => {});
    },
  };
}
