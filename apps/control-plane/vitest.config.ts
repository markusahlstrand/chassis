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
        miniflare: {
          // Enables the UNSAFE dev-actor stub for the test only (never in
          // wrangler.jsonc, so a real deploy stays fail-closed — see src/worker.ts).
          bindings: { ALLOW_DEV_ACTOR: 'true' },
          // The vertical service binding names a SEPARATELY deployed worker
          // (`substrat-fsm`), which does not exist in the test runtime — without a
          // stub, workerd refuses to start at all. It answers 501 so a test that
          // reaches it fails loudly rather than silently provisioning nothing.
          serviceBindings: {
            VERTICAL_FSM: () =>
              new Response(JSON.stringify({ error: 'vertical not available in tests' }), {
                status: 501,
                headers: { 'content-type': 'application/json' },
              }),
          },
        },
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
