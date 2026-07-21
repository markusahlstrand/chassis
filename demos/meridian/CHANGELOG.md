# @substrat-run/demo-hr

## 0.0.8

### Patch Changes

- Updated dependencies [462e8c9]
  - @substrat-run/connector-scrive@0.1.0

## 0.0.7

### Patch Changes

- 0ffb6c8: **Meridian wires the Scrive connector — the reference call site for the poll path (#96 Gate 1).**

  The scheduler driver (`runPlatformSweep` / `startPlatformSweeper`) and the connector's reconcile
  sweep landed with no deployment calling them. Meridian — the vertical whose anställningsavtal is a
  Scrive-signed document — now is that call site:

  - Depends on `@substrat-run/connector-scrive` via `workspace:^` (no npm publish needed to consume
    it in-repo — the whole point: the bundler compiles it in).
  - `buildDemoHost(dir, scrive?)` registers the connector and seals connection credentials with a
    `SecretBox`, opt-in; the default host (every existing test) is unchanged.
  - `connectScrive(host, …)` opens a `(tenant, meridian, scrive)` connection holding ONLY
    `protocol:record-signature` — the #97 grant that lets the reconcile write a signature back as the
    connection itself, not a human role. Scopes now name `vertical: 'meridian'` so a connection can
    reach them.
  - `server.ts` resolves Scrive from the environment (real testbed creds → global fetch; or
    `MERIDIAN_SCRIVE_MOCK=1` → `ScriveMock` with a dev-only sign endpoint), then calls
    `startPlatformSweeper` — the one-line trigger a deployment adds. Off by default: no creds, no
    connection, the contract sits pending, which is honest without a provider.

  Proven end to end: a new test drives issue → dispatch → provider signs → `runPlatformSweep` →
  instance `signed`, and the running server does the same over HTTP (`pending_signature` →
  `/api/dev/scrive-sign` → sweeper → `signed`). All 14 existing scenario tests and 3 provision tests
  still pass — the wiring is additive and opt-in.

  This closes Gate 1: with a Scrive account that has BankID/test-signing enabled, the connector now
  completes a signature unattended.

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/connector-scrive@0.0.2
  - @substrat-run/engine-protocol@0.4.2

## 0.0.6

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/engine-protocol@0.4.1

## 0.0.5

### Patch Changes

- Updated dependencies [3336a17]
- Updated dependencies [27872cc]
  - @substrat-run/engine-protocol@0.4.0
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-protocol@0.3.6

## 0.0.3

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-protocol@0.3.5

## 0.0.2

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0
- @substrat-run/engine-protocol@0.3.3
