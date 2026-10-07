import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_PROXY_TARGET lets `npm run dev -w apps/web` talk to an API on another port.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000';

// Capture URLs (`/<uuid>[/sub/path]`) are proxied too, so the URL shown in the UI
// (http://localhost:5173/<uuid>) works as-is from Postman in development.
const uuidPath =
  '^/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(/|\\?|$)';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // ws: true also carries the Socket.IO upgrade (Phase 4) on /api/socket.io.
      '/api': { target: proxyTarget, changeOrigin: true, ws: true },
      [uuidPath]: { target: proxyTarget, changeOrigin: true },
      // Dev mail catcher (admin-only): emails the API "sends" in dev are readable here.
      '/devmailcatcher': { target: proxyTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
