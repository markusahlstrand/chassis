import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports in the private 887x/527x block. The admin app is :5277, the API on :8877; the
// same two vars drive src/server.ts, so `PORT=… WEB_PORT=…` moves both ends of the proxy.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5277);
const API_PORT = Number(process.env.PORT ?? 8877);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/.well-known': `http://localhost:${API_PORT}`,
    },
  },
});
