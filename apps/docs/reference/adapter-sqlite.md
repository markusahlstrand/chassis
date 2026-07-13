# @chassis/adapter-sqlite

The **pure-SQLite scope host** — real kernel semantics with no Cloudflare dependency.
One SQLite file per scope, a per-scope actor for strict serialization, a directory
database for fail-closed addressing, and a kernel-stamped event outbox.

It is **not a mock**: it is the adapter local development and CI run on, and the reason
the self-host/escrow story is literally true (single-node, but runnable).

```sh
pnpm add @chassis/adapter-sqlite
```

## Usage

```ts
import { SqliteScopeHost } from '@chassis/adapter-sqlite';
import { UNSAFE_allowAllChecker } from '@chassis/kernel';

const host = new SqliteScopeHost({
  dir: './data',                    // one .sqlite file per scope + _directory.sqlite
  checker: UNSAFE_allowAllChecker,  // omit for the secure default: deny everything
});

await host.provisionScope({ tenantId, scopeId, jurisdiction: 'eu' }); // idempotent
const stub = await host.getScope(principal, tenantId, scopeId);
await stub.invoke('workorder/create', input);
await host.close();
```

## How the semantics map

| Contract guarantee | Implementation here | In production (planned CF adapter) |
|---|---|---|
| strict serialization per scope | in-process actor, one queue per scope | Durable Object single-threaded execution |
| scope storage isolation | one SQLite file per scope | one DO (SQLite-backed) per scope |
| fail-closed addressing | `_directory.sqlite` cross-check | directory + DO addressing |
| structured-clone boundary | explicit `structuredClone` on both directions | the RPC boundary itself |
| stamped event envelopes | outbox table written in the same transaction | same, drained to the event spine |

This adapter passes the full
[`@chassis/contract-tests`](/reference/contract-tests) suite — the same suite the
Cloudflare adapter must pass unchanged.

## Debugging is opening a file

Scope databases run in WAL mode and can be opened read-only with any SQLite tool:

```sh
sqlite3 ./data/<scopeId>.sqlite '.tables'
sqlite3 ./data/_directory.sqlite 'SELECT * FROM scopes;'
```

## Notes

- Uses [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) (native module).
  With pnpm 10+, allow its build script via `pnpm.onlyBuiltDependencies`.
- Single-node by design: it preserves the serialization *semantics*, not the scale-out.
  Production scale-out is the Cloudflare adapter's job.
- Pre-release: migration journal, attachments, and the outbox drain are still landing.
