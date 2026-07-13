# FSM demo — "ServiceCo"

The first demo vertical: a small Swedish service/installation firm built on the
Chassis kernel and the work-order + invoicing engines.

- **Concept:** [spec/concept.md](spec/concept.md)
- **Implementation spec** (schemas, operations, events, permissions, scenario):
  [spec/testrun.md](spec/testrun.md)
- **View specifications:** [spec/views.md](spec/views.md)

Status: spec complete, implementation pending — blocked on the kernel deltas listed in
[spec/testrun.md](spec/testrun.md) §9.2 (module registration + migration journal,
`ctx.link`, local event dispatch, tuple checker, admin surface).

Demo verticals under `demos/` are private and never published. The engines they consume
live in `engines/` — they are product seeds shared across demos, not demo material.
