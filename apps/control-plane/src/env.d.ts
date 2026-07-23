// The bindings the workerd test reaches through `cloudflare:test`'s `env`, plus
// the dev-actor flag miniflare injects (vitest.config.ts).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SCOPE: DurableObjectNamespace;
    CONTROL_PLANE: DurableObjectNamespace;
    /** Better Auth's store, and the staff roster (#42). Bound in wrangler.jsonc. */
    AUTH_DB: D1Database;
    ALLOW_DEV_ACTOR?: string;
    /** Signs sessions/flow — bound in vitest.config.ts so the CLI-broker test can mint them. */
    SESSION_SECRET?: string;
  }
}
