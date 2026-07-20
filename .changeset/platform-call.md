---
'@substrat-run/kernel': minor
---

`assertPlatformCall` — the vertical's side of a platform-to-vertical call (K-31).

Provisioning is control-plane-driven, because only the vertical can create a usable
scope DO: the DO class bundles the modules and lives in the vertical's own deployment.
This authenticates that call, in the kernel for the same reason `readRoutedNode` is —
five verticals each re-deriving how to trust a header is five chances to get it wrong.

It **fails closed with no configuration at all**, which is the opposite of the router
secret. There, an unset secret means "no router is configured", which a standalone
deploy legitimately wants. Here it would mean "anyone may provision", which nothing
legitimately wants — a template copied without the secret must refuse rather than mint
tenants for strangers.
