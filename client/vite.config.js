import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em dev, o Vite repassa a API/WebSocket para o padospeak-server (3000) e o painel (3001).
export default defineConfig({
  plugins: [react()],
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
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
