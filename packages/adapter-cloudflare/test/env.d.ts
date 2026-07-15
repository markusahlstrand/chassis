// Type the bindings the contract tests reach through `cloudflare:test`'s `env`.
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SCOPE: DurableObjectNamespace;
    CONTROL_PLANE: DurableObjectNamespace;
  }
}
