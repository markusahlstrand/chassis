---
"@substrat-run/control-plane-api": minor
---

Service auth for connected verticals, and a workerd fetch fix.

- `serviceTokenAuth` + `SERVICE_TOKEN_HEADER` — a shared-token credential a
  vertical presents to register into the control plane (a service, not staff),
  and `firstPlatformActorAuth` to compose it with session/dev auth.
- `ControlPlaneClient` gains a `serviceToken` option (sent as `x-service-token`).
- **Fix:** `ControlPlaneClient` bound `globalThis.fetch` incorrectly, throwing
  "Illegal invocation" on workerd. It is now bound to the global scope, so the
  client works inside a Worker (over a service binding or plain fetch).
