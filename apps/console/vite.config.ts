import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the private 887x/527x block the demos use, clear of the Vite
// and Wrangler defaults. API_PORT matches the control-plane API's dev server
// (packages/control-plane-api/dev/server.mts), so `pnpm dev` in both places
// meets in the middle with no configuration.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5272);
const API_PORT = Number(process.env.PORT ?? 8788);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
