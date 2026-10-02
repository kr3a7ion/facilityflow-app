import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
    // In development the client runs on its own port and talks to the host process.
    proxy: { '/api': { target: 'http://localhost:4700', changeOrigin: true } },
  },
});
