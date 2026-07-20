---
'@substrat-run/control-plane-api': minor
---

`VerticalClient` and `POST /verticals/:slug/instances` — the platform's side of K-31.

Provisioning is control-plane-driven because only the vertical can create a usable
scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
This is the mirror of `ControlPlaneClient`, pointing the other way — that one is a
vertical talking up to the platform, this is the platform telling a vertical to act.

Deliberately tiny. Provisioning is the only thing the platform asks a vertical to do,
and every additional verb would be authority the platform holds over someone else's
code.

`createControlPlaneApi` takes an optional `verticals` map. A slug with no binding gets
a **501** rather than a silent success: a control plane that does nothing while
reporting success is worse than one that says it cannot. The vertical's own status is
propagated rather than flattened to 500, because a 403 means the platform secrets do
not match — a deployment error someone must act on.
