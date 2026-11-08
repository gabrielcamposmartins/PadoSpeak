// Prepara os arquivos pesados dos recursos que rodam no aparelho (servidos em /api/models, veja
// server/src/model_files.rs): o wasm do MediaPipe (copiado do mesmo node_modules do app, para casar com o JS que
// vai no worker) e o modelo de gestos (baixado da versão fixa e conferido pelo SHA-256). Gera nomes com o hash, as
// versões comprimidas (.br/.gz) do wasm e do JS e o manifest.json.
//
//   node scripts/fetch-models.mjs [pasta]        (padrão: ./models; no Docker, /out/models)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const out = path.resolve(process.argv[2] || 'models');
const cacheDir = path.resolve('scripts/.cache');
const require = createRequire(path.resolve('client/package.json'));

/** Modelo de gestos: a versão fixa `float16/1` (o "latest" pode mudar por baixo). */
const GESTURE = {
  url: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
  sha256: '97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482',
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download({ url, sha256 }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, `${sha256}.bin`);
  if (fs.existsSync(cached) && sha(fs.readFileSync(cached)) === sha256) return fs.readFileSync(cached);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== sha256) throw new Error(`${url}: SHA-256 diferente do esperado (${sha(buf)})`);
  fs.writeFileSync(cached, buf);
  return buf;
}

function put(id, base, ext, buf, extra = {}) {
  const hash = sha(buf);
  const file = `${base}-${hash.slice(0, 10)}.${ext}`;
  fs.writeFileSync(path.join(out, file), buf);
  if (ext === 'wasm' || ext === 'js') {
    fs.writeFileSync(path.join(out, `${file}.br`), zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
    fs.writeFileSync(path.join(out, `${file}.gz`), zlib.gzipSync(buf, { level: 9 }));
  }
  return [id, { file, sha256: hash, size: buf.length, ...extra }];
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// o pacote não exporta o package.json: acha a pasta pelo arquivo principal
const pkgPath = path.join(path.dirname(require.resolve('@mediapipe/tasks-vision')), 'package.json');
const mp = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const wasmDir = path.join(path.dirname(pkgPath), 'wasm');
const cdn = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${mp.version}/wasm`;
const assets = Object.fromEntries([
  put('mp-vision-loader', `mp-vision-${mp.version}`, 'js', fs.readFileSync(path.join(wasmDir, 'vision_wasm_module_internal.js')), {
    version: mp.version,
    mirror: `${cdn}/vision_wasm_module_internal.js`,
  }),
  put('mp-vision-wasm', `mp-vision-${mp.version}`, 'wasm', fs.readFileSync(path.join(wasmDir, 'vision_wasm_module_internal.wasm')), {
    version: mp.version,
    mirror: `${cdn}/vision_wasm_module_internal.wasm`,
  }),
  put('mp-gesture-task', 'mp-gesture-f16-1', 'task', await download(GESTURE), { version: 'float16/1', mirror: GESTURE.url }),
]);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ v: 1, assets }, null, 2));
for (const [id, a] of Object.entries(assets)) console.log(`${id.padEnd(18)} ${a.file}  ${(a.size / 1048576).toFixed(1)} MB`);
console.log(`pronto em ${out}`);
