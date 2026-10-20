import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const page = (name) => fileURLToPath(new URL(name, import.meta.url));
const { version } = JSON.parse(readFileSync(page('package.json'), 'utf8'));
// Cada build tem um id: o app aberto no navegador compara o dele com o `version.json` do servidor para
// saber que saiu versão nova (veja lib/update.js).
const build = `${version}-${Date.now().toString(36)}`;
const versionFile = {
  name: 'padospeak-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, build }) });
  },
};

// O servidor manda o app comprimido sem gastar CPU: cada JS, CSS, HTML e wasm do build ganha ao lado
// uma cópia `.br` e uma `.gz`, e o servidor só escolhe a que o navegador aceita (server/src/assets.rs).
const PACK = /\.(js|css|html|wasm|svg|json)$/;
const precompress = {
  name: 'padospeak-precompress',
  apply: 'build',
  writeBundle({ dir }, bundle) {
    for (const name of Object.keys(bundle)) {
      if (!PACK.test(name)) continue;
      const file = join(dir, name);
      const data = readFileSync(file);
      if (data.length < 1024) continue;
      const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
      if (br.length < data.length * 0.9) writeFileSync(`${file}.br`, br);
      const gz = gzipSync(data, { level: 9 });
      if (gz.length < data.length * 0.9) writeFileSync(`${file}.gz`, gz);
    }
  },
};

// Tamanho da fonte (Configurações → Aparência): todo `font-size` em px do styles.css vira
// `calc(Npx * var(--fs))`, e `--fs` vem da escolha da pessoa (um pouco maior no celular). O CSS continua
// escrito em px; quem precisa de outra conta (as caixas de texto do toque) já escreve a própria.
const fontScale = {
  postcssPlugin: 'padospeak-font-scale',
  Declaration(decl) {
    if (!/[\\/]src[\\/]styles\.css$/.test(decl.source?.input.file || '')) return;
    const px = decl.prop === 'font-size' ? /^(\d*\.?\d+)px$/ : decl.prop === 'font' ? /^(\d*\.?\d+)px(?=[\s/])/ : null;
    if (px) decl.value = decl.value.replace(px, 'calc($1px * var(--fs, 1))');
  },
};

// Em dev, o Vite repassa a API/WebSocket para o padospeak-server (3000) e o painel (3001).
export default defineConfig({
  plugins: [react(), versionFile, precompress],
  css: { postcss: { plugins: [fontScale] } },
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/panel-api': 'http://localhost:3001',
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
    // dock.html: o dock flutuante da transmissão no app do Windows (veja src/dock.jsx).
    rollupOptions: { input: { main: page('index.html'), dock: page('dock.html'), overlay: page('overlay.html') } },
  },
});
