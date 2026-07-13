# FSM demo — "ServiceCo"

The first demo vertical: a small Swedish service/installation firm built on the
Substrat kernel and the work-order + invoicing engines. **Runs end-to-end**: React UI →
Hono API → kernel operations → per-scope SQLite, with the tuple permission engine
enforcing every call.

## Run it

```bash
pnpm install
pnpm fsm-demo dev   # from anywhere in the repo — starts API (:8787) + web app (:5173)
```

(`pnpm fsm-demo <script>` is a root-level pass-through to this package: `dev`,
`server`, `test`, `typecheck` all work.)

Open http://localhost:5173 and switch cast members in the top-right corner:

| Who | Role | What to try |
|---|---|---|
| **Anna** (kontor) | office-admin | Create a work order, assign Harald, complete it — the priced review sheet shows min-qty and dropped internal articles; then export the fakturaunderlag |
| **Harald** (tekniker) | technician | Start the job, report time and material; try assigning — denied |
| **Berit** (portal) | BRF Grunden customer | Sees exactly her organization's orders — via a tuple proof walk, not UI filtering |
| **Styrbjörn** (portal) | Kontorshotellet customer | Sees nothing of Berit's orders |
| **Mallory** | office-admin of *another firm* | Every request 403s — she holds no tuples in this tenant |

Data lives in `demos/fsm/.data/*.sqlite` — open any scope file in a SQLite browser;
that's the escrow story, live. Delete `.data/` to reseed.

## Specs

- **Concept:** [spec/concept.md](spec/concept.md)
- **Implementation spec** (schemas, operations, events, permissions, scenario):
  [spec/testrun.md](spec/testrun.md)
- **View specifications:** [spec/views.md](spec/views.md)

`pnpm --filter @substrat-run/demo-fsm test` runs the headless nine-step scenario from
spec/testrun.md §8.

Demo verticals under `demos/` are private and never published. The engines they consume
live in `engines/` — product seeds shared across demos, not demo material.
