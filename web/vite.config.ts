import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: process.env.VITE_SERVER_TARGET?.replace(/^http/, 'ws') || 'ws://localhost:8787', ws: true },
      '/assets': process.env.VITE_SERVER_TARGET || 'http://localhost:8787',
      '/media': process.env.VITE_SERVER_TARGET || 'http://localhost:8787',
      '/api': process.env.VITE_SERVER_TARGET || 'http://localhost:8787',
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
