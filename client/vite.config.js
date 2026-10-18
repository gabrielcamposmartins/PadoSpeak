import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

// Em dev, o Vite repassa a API/WebSocket para o padospeak-server (3000) e o painel (3001).
export default defineConfig({
  plugins: [react(), versionFile],
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
