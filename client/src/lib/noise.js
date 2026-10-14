// Supressão de ruído com RNNoise (rede neural da Xiph, compilada para WebAssembly) num AudioWorklet.
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

let wasmPromise = null;

/**
 * Passa o áudio do microfone pelo RNNoise.
 * @returns {Promise<{ stream: MediaStream, close: () => void }>} stream limpo e função para liberar recursos
 */
export async function suppressNoise(input) {
  wasmPromise ||= loadRnnoise({ url: wasmUrl, simdUrl }).catch((e) => {
    wasmPromise = null;
    throw e;
  });
  // O RNNoise trabalha a 48 kHz.
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary: await wasmPromise, maxChannels: 1 });
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(input).connect(node).connect(dest);
    if (ctx.state === 'suspended') await ctx.resume();
    return {
      stream: dest.stream,
      close() {
        node.destroy();
        ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    ctx.close().catch(() => {});
    throw e;
  }
}
