import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Private 887x/527x block. `PORT=… PLAYER_PORT=… pnpm dev` moves both ends.
const PLAYER_PORT = Number(process.env.PLAYER_PORT ?? 5277);
const API_PORT = Number(process.env.PORT ?? 8877);

export default defineConfig({
  plugins: [react()],
  server: {
    port: PLAYER_PORT,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
});
