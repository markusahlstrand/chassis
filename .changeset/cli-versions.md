---
'@substrat-run/cli': minor
---

**`substrat versions <slug>`** — list a vertical's versions and which channels point at
them, from the CLI. The first slice of *builder self-service visibility*: seeing the
verticals you pushed without the staff console.

It reads the existing registry endpoints (`/verticals/:slug/versions`, `/channels`), so
it works for staff today and — once builder-scoped authz + slug ownership land — for
builders viewing their own verticals. Read-only; admission and prod promotion stay the
staff trust gate (self-serve-deploy.md model B).
