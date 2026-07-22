import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the private 527x/887x block the demos + console use, clear of
// the Vite and Wrangler defaults. API_PORT matches the dashboard worker's dev
// server (`wrangler dev --port 8890`, see apps/dashboard/package.json) so
// `pnpm dev` in both places meets in the middle with no configuration.
//
// Unlike the console (whose control-plane API serves at the root), the dashboard
// worker already serves its routes UNDER `/api` — so this proxy keeps the path
// intact (no rewrite). The OIDC round-trip under `/api/auth/*` goes through the
// same proxy, so sign-in works against the local worker.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5275);
const API_PORT = Number(process.env.PORT ?? 8890);

export default defineConfig({
  // Assets are served by the worker from its own origin (app.substrat.net) at the
  // root, so keep the default base.
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
});
