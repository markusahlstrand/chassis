---
"@substrat-run/control-plane-api": minor
---

Add the vertical-side connect seam and swappable staff auth.

- `ControlPlaneClient` — a typed HTTP client that registers a tenant, entitlements,
  and scope into a separately-run control plane, plus `assertScopeActive`, a gate
  that fails closed on the directory's authoritative lifecycle (tenant-level
  cascade included). `fetch` is injectable.
- `sessionPlatformAuth(readSession, resolveActor)` + `staffAllowlist` — the real
  `PlatformActorAuth` for platform staff, split so the auth provider and the staff
  roster are independent. Swapping the provider (e.g. to AuthHero) changes only the
  session reader.
