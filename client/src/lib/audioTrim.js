// Cortar o som antes de enviar: a "onda" do arquivo (picos), ouvir só o trecho escolhido e gerar o
// arquivo do trecho (WAV 16 bits, até 48 kHz e 2 canais, com uma rampa curtinha nas pontas para não
// estalar). 15 s em estéreo a 48 kHz dão ~2,9 MB, dentro dos 5 MB do servidor.
import { soundContext, soundOutput } from './soundboard.js';

/** Duração máxima de um som rápido (s). O servidor recusa acima disso. */
export const MAX_SOUND_SEC = 15;
/** Trecho mínimo (s), para as alças não se encostarem. */
export const MIN_SOUND_SEC = 0.3;
const FADE_SEC = 0.008;

export async function decodeAudioFile(file) {
  return soundContext().decodeAudioData(await file.arrayBuffer());
}

/** `n` picos (0 a 1) do áudio todo, para desenhar a onda. */
export function peaks(buffer, n = 120) {
  const out = new Array(n).fill(0);
  const step = Math.max(1, Math.floor(buffer.length / n));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let max = 0;
      const from = i * step;
      const to = Math.min(data.length, from + step);
      // Pula amostras nos arquivos longos: o pico continua bom e não trava a tela.
      const stride = Math.max(1, Math.floor((to - from) / 2000));
      for (let j = from; j < to; j += stride) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      if (max > out[i]) out[i] = max;
    }
  }
  const top = Math.max(...out) || 1;
  return out.map((v) => v / top);
}

/** Toca só o trecho (s). Devolve `{ stop, at }`: `at()` é a posição atual no arquivo, ou null se acabou. */
export function playClip(buffer, start, end, volume = 0.8, onEnd) {
  const ac = soundContext();
  const src = ac.createBufferSource();
  const gain = ac.createGain();
  gain.gain.value = Math.max(0, Math.min(1.5, volume));
  src.buffer = buffer;
  src.connect(gain).connect(soundOutput());
  const t0 = ac.currentTime;
  let done = false;
  src.onended = () => {
    done = true;
    onEnd?.();
  };
  src.start(0, start, end - start);
  return {
    stop() {
      if (done) return;
      done = true;
      try {
        src.stop();
      } catch {
        /* já parou */
      }
    },
    at: () => (done ? null : Math.min(end, start + (ac.currentTime - t0))),
  };
}

/** O trecho como arquivo WAV. */
export async function clipToWav(buffer, start, end) {
  const rate = Math.min(48000, buffer.sampleRate);
  const channels = Math.min(2, buffer.numberOfChannels);
  const len = Math.max(1, Math.round((end - start) * rate));
  const off = new OfflineAudioContext(channels, len, rate);
  const src = off.createBufferSource();
  const gain = off.createGain();
  src.buffer = buffer;
  const dur = len / rate;
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(1, FADE_SEC);
  gain.gain.setValueAtTime(1, Math.max(FADE_SEC, dur - FADE_SEC));
  gain.gain.linearRampToValueAtTime(0, dur);
  src.connect(gain).connect(off.destination);
  src.start(0, start, end - start);
  const out = await off.startRendering();
  return new Blob([wav(out)], { type: 'audio/wav' });
}

function wav(b) {
  const ch = b.numberOfChannels;
  const n = b.length;
  const view = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, b.sampleRate, true);
  view.setUint32(28, b.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => b.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return view.buffer;
}
