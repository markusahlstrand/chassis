import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults that every other project on the machine also wants.
// The same two vars drive src/server.ts, so `PORT=… WEB_PORT=… pnpm dev` moves
// both ends of the proxy together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273);
const API_PORT = Number(process.env.PORT ?? 8873);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 5274);

export default defineConfig({
  plugins: [react()],
  // Staff who land on the storefront get a hand-off link to the back-office;
  // deriving it from ADMIN_PORT keeps the two apps in step when either moves.
  define: {
    __ADMIN_ORIGIN__: JSON.stringify(`http://localhost:${ADMIN_PORT}`),
  },
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
});
