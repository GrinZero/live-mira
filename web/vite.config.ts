import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/assets': 'http://localhost:8787',
      '/media': 'http://localhost:8787',
      '/api': 'http://localhost:8787',
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
