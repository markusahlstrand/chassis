// The bindings the workerd test reaches through `cloudflare:test`'s `env`, plus
// the dev-actor flag miniflare injects (vitest.config.ts).
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SCOPE: DurableObjectNamespace;
    CONTROL_PLANE: DurableObjectNamespace;
    ALLOW_DEV_ACTOR?: string;
  }
}
