// Reconhecimento de gestos fora da tela (Web Worker): recebe um quadro pequeno da câmera por vez (ImageBitmap) e
// devolve o gesto, a confiança, se há mão, onde está o pulso e quanto tempo levou. Usa o caminho pedido (placa de
// vídeo ou processador); se a placa de vídeo não abrir, usa o processador. Trocar de caminho é abrir outro worker
// (dois reconhecedores no mesmo wasm não dão certo; veja `controller.js`).
import { GestureRecognizer } from '@mediapipe/tasks-vision';

let recognizer = null;
let delegate = 'GPU';
let lastTs = 0;

async function create(files, want) {
  recognizer = await GestureRecognizer.createFromOptions(
    { wasmLoaderPath: files.loaderUrl, wasmBinaryPath: files.wasmUrl },
    {
      baseOptions: { modelAssetBuffer: new Uint8Array(files.model), delegate: want },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
      cannedGesturesClassifierOptions: { scoreThreshold: 0.5 },
    },
  );
  delegate = want;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    const want = data.delegate === 'CPU' || typeof OffscreenCanvas === 'undefined' ? 'CPU' : 'GPU';
    try {
      await create(data, want);
    } catch {
      if (want === 'CPU') return self.postMessage({ type: 'error', message: 'não abriu' });
      try {
        await create(data, 'CPU');
      } catch (e) {
        return self.postMessage({ type: 'error', message: String(e?.message || e) });
      }
    }
    self.postMessage({ type: 'ready', delegate });
    return;
  }
  if (data.type === 'frame') {
    const { bitmap } = data;
    if (!recognizer) {
      bitmap.close();
      return self.postMessage({ type: 'result', gesture: 'None', score: 0, hand: false, ms: 0, delegate });
    }
    // o relógio do vídeo precisa sempre andar
    const ts = Math.max(lastTs + 1, Math.round(data.ts));
    lastTs = ts;
    const t0 = performance.now();
    let res = null;
    try {
      res = recognizer.recognizeForVideo(bitmap, ts);
    } catch {
      res = null;
    }
    bitmap.close();
    const top = res?.gestures?.[0]?.[0];
    const marks = res?.landmarks?.[0];
    self.postMessage({
      type: 'result',
      gesture: top?.categoryName || 'None',
      score: top?.score || 0,
      hand: Boolean(marks?.length),
      // pulso (ponto 0) e a largura da mão na imagem (0–1)
      wrist: marks?.[0] ? { x: marks[0].x, y: marks[0].y } : null,
      size: marks ? Math.max(...marks.map((p) => p.x)) - Math.min(...marks.map((p) => p.x)) : 0,
      ms: performance.now() - t0,
      delegate,
    });
  }
};
