import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        // The directory persists across requests within a run — a tenant written
        // by one request must be readable by the next, which is the durability
        // this slice exists to prove. Do NOT roll storage back per test.
        isolatedStorage: false,
        singleWorker: true,
        // Enables the UNSAFE dev-actor stub for the test only (never in
        // wrangler.jsonc, so a real deploy stays fail-closed — see src/worker.ts).
        miniflare: { bindings: { ALLOW_DEV_ACTOR: 'true' } },
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
