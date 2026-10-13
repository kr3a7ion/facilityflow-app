import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // No source maps in the build: the host serves dist/ to every device, and through the
  // tunnel to the internet, so a map would publish the whole client source. `npm run dev`
  // still has them.
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    // In development the client runs on its own port and talks to the host process.
    proxy: { '/api': { target: 'http://localhost:4700', changeOrigin: true } },
  },
});
