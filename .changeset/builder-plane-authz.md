---
'@substrat-run/control-plane-api': minor
---

**Builder authz on the control-plane API (builder-plane.md Phase 2).** A second principal
kind — a *tenant user* — joins staff/service on the same surface, confined to the
vertical-management routes and to the verticals their tenant **owns** (the `owner_tenant`
column from Phase 1b). The mechanism ships tested against a stub; the real builder-session
reader (session → user → selected tenant) and CLI wiring land with Phase 3.

- **`authenticateBuilder?: BuilderAuth`** — a new, optional `createControlPlaneApi` option
  resolving a request to a `{ actor, tenantId }` builder principal. Tried only after
  `authenticate` (staff/service) declines, so staff auth is **unchanged** and remains a
  superset. Absent ⇒ the surface is staff/service-only exactly as before.
- **Fail-closed confinement** — a builder reaches only an explicit allowlist of
  vertical-management routes (`GET`/`POST /verticals`, `…/versions`, `…/channels`, promote,
  deploy). Everything else — tenants, scopes, hostnames, admin-log, instance provisioning,
  and `versions/:id/{admit,reject}` — is `403` for a builder. Default-deny by design: a
  route not on the allowlist denies builders (a missing feature), never escalates.
- **Ownership checks** — register/deploy **claim** an unregistered slug for the caller's
  tenant or require they already own it (`403` otherwise); publish/promote require ownership;
  `GET` of an unowned vertical is `404` (indistinguishable from absent, K-3's reflex). The
  owner is stamped from the principal, never trusted from the body. Staff pushes preserve the
  existing owner rather than clobbering it.
- **Model B, staff keep the prod gate** — a builder self-serves `dev`/`staging` promotion;
  **`prod` promotion and admission stay staff-only**, the trust boundary self-serve-deploy.md
  §3 draws.
- **`GET /verticals`** is filtered to the caller's owned verticals for a builder; staff see
  the whole registry.

Internally the auth middleware now sets both `actor` (the audited subject, unchanged for
every HostAdmin call) and a new `principal` (the authz distinction) — existing routes are
untouched. `errors.ts` maps the Phase-1b claim conflict (`is owned by …`) to 409.

Verified: control-plane-api suite (71) incl. a new builder-authz matrix — claim, cross-tenant
refusal, list filtering, non-prod self-serve, staff-only prod/admit, deploy-path claim — and
the control-plane worker suite (13) both pass; `pnpm -r typecheck` clean.
