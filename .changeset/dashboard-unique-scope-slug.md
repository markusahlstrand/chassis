---
"@substrat-run/dashboard": patch
---

**Fix "scope slug 'x' already taken" when installing an app in connected mode.** The shared-plane
provisioning used `slugify(name)` as the scope slug, which must be unique within a tenant — so a
second app with the same name, or a fresh attempt after a failed one left an orphaned scope (a
failed provision marks the row failed but doesn't release its shared-plane scope), collided. The
scope slug now includes the scope-id tail (`meridian-abc123`); the bound hostname still prefers the
clean name (`meridian.global.substrat.run`), falling back to the unique slug only on a global collision.
