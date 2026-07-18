import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults. The same vars drive src/server.ts, so
// `PORT=… CONSOLE_PORT=… pnpm dev` moves both ends of the proxy together.
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 5278);
const API_PORT = Number(process.env.PORT ?? 8877);

export default defineConfig({
  plugins: [react()],
  server: {
    port: CONSOLE_PORT,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
});
