---
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-protocol': patch
---

English vocabulary on the published surface. The invoicing engine's permission
descriptions now read `Read invoice bases` / `Export an invoice basis (makes it
immutable)` instead of naming the Swedish *fakturaunderlag*, and the protocol
engine's README says "self-inspection" rather than *egenkontroll*.

Permission **keys** are unchanged (`invoicing:read`, `invoicing:export`) — this is
description text only, so nothing to migrate. The engines' README keeps the Swedish
term as a parenthetical gloss where it documents the domain it was extracted from.
