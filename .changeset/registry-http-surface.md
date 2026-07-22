---
'@substrat-run/control-plane-api': minor
---

**Expose the vertical + version registry over the control-plane HTTP API (orchestration.md Phase 1a).**

The registry data model — verticals, versions, channels, admission, and the digest-diff
promotion gate — was already built at the `HostAdmin` + adapter layer but had no HTTP
surface. This adds thin pass-through routes so a staff caller (and the console) can drive it:

- `GET/POST /verticals` — list, register
- `GET/POST /verticals/:slug/versions` — list, publish (lands **pending**; body slug must
  match the path, K-3-style cross-check)
- `POST /verticals/:slug/versions/:id/{admit,reject}` — the admission checkpoint
- `GET /verticals/:slug/channels` + `POST /verticals/:slug/channels/:channel/promote` — the
  promotion checkpoint, which refuses a changed permission/migration digest unless
  acknowledged
- `POST /tenants/:tenantId/scopes/:scopeId/version` — bind a scope to an admitted version

`errors.ts` gains status mappings so registry refusals surface as `404`/`409` rather than
`500`. No `deploy` route (the worker uploader) — that is Phase 2. The actor is still stamped
from the authenticated request, never the body.
