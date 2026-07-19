---
'@substrat-run/control-plane-api': minor
---

The hostname map is on the audited HTTP surface: `GET /hostnames`,
`POST /hostnames`, `PATCH /hostnames/:hostname/status`.

`resolveHostname` is deliberately **not** here. It is the router's per-request machine
path, unaudited by design (K-24), and the router reads the directory directly. Putting
it on the staff surface would either flood the admin log or quietly add an unaudited
route to a surface whose whole claim is that it is audited.

`ControlPlaneClient` is unchanged: that is the *vertical's* client, and a vertical
assigning itself a domain is not a thing we want to be possible.
