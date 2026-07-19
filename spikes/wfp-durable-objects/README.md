# Spike: can a WfP user worker define its own Durable Object class?

**Status: probably yes, unverified.** The documentary evidence leans one way (below)
and stops short of stating it. This directory exists to settle it, then be deleted.

## The question, and why it decides things

We are the hosting environment. A vertical developer pushes code; *our* orchestration
layer deploys it into *our* Cloudflare account with *our* credentials. The customer
never holds a Cloudflare token. Workers for Platforms is built for exactly this.

The complication is what a Substrat vertical *is*. `defineScopeDO(MODULES)` puts the
kernel, the engines and the vertical's module code **inside** the Durable Object. A
vertical is not a worker that talks to a DO — it is a worker that **defines** one.

So the whole fit turns on one fact:

> Can a user worker uploaded to a dispatch namespace define its own SQLite-backed
> Durable Object class, or may it only bind to a class defined in another script?

No page states it outright. What the docs *do* say, in order of how much it is worth:

- The [dispatch-namespace script API][u] returns **`migration_tag`** — "the tag of the
  Durable Object migration that was most recently applied for this Worker". A response
  field about applied DO migrations, on scripts in a dispatch namespace, is hard to
  explain if such scripts cannot have DO migrations.
- The [multipart upload metadata][m] spec lists **`migrations`** as an accepted field,
  and the dispatch upload takes that same metadata shape.
- [WfP bindings][b] says each of your users can have "their own Durable Objects class",
  which is suggestive but ambiguous — "their own" could be a class they define or an
  instance they were handed.
- The [Durable Objects known issues][k] page records no dispatch-namespace restriction.

That is a strong lean and not a guarantee. It says nothing about account-level gating,
and none of it is a sentence anyone at Cloudflare wrote about this case. Too
load-bearing to assume, cheap to check — hence this.

## What the spike does

Two steps, because the first alone would not settle it. An upload being **accepted**
is not evidence the class **instantiates**, and instantiating is not evidence that
**SQLite storage** works — which is the storage every scope uses.

1. `upload.mjs` — uploads [`user-worker.mjs`](./user-worker.mjs) to a dispatch
   namespace with `migrations: { new_sqlite_classes: ['ScopeDO'] }` and a
   `durable_object_namespace` binding **without** `script_name`, so the class must be
   this script's own. It tries both documented shapes of the `migrations` field, so a
   rejection on formatting cannot be misread as a rejection on capability.
2. `dispatcher/` — a minimal dynamic-dispatch worker. Curl it, and the request goes
   dispatcher → user worker → its own DO → `CREATE TABLE` + `INSERT` + `SELECT`.

A response containing `readBack` equal to the scope you asked for is the proof.

## Running it

Needs an account with Workers for Platforms enabled (a paid add-on) and a token with
**Workers Scripts: Edit**.

```sh
export CF_ACCOUNT_ID=…
export CF_API_TOKEN=…

node upload.mjs                       # step 1 — the fork-decider
cd dispatcher && pnpm install && pnpm run deploy
curl "https://substrat-spike-dispatcher.<subdomain>.workers.dev/?scope=scope-a"
```

Expected on success:

```json
{ "ok": true, "via": "user-worker", "wrote": "scope-a", "readBack": "scope-a", "id": "…" }
```

Try a second `?scope=scope-b` and confirm the `id` differs — one DO per scope is the
addressing the kernel actually uses, so it should hold here too.

## Reading the result

**If it is accepted and runs** — WfP drops into the current architecture with no
redesign. A customer's vertical becomes a user worker exporting its own `ScopeDO`,
uploaded by us with our token. D-30 holds by construction: separate scripts, separate
DO classes, no lockstep engine upgrades across verticals owned by different companies.
The router's `verticalFor` swaps a static service binding for `env.DISPATCH.get(name)`
— the same `Fetcher` type, which is why that lookup was kept in one function.

**If it is rejected** — this is a real fork and it must be settled as a decision
before anything is designed on top of it. The options, neither of them free:

- **Platform-owned generic DO.** Verticals stop shipping module code inside the DO.
  That contradicts how every engine and vertical is written today, so it is a large
  change, not a configuration one.
- **Verticals stay ordinary Workers**, deployed by our orchestration with our token —
  which works *today*, with no WfP at all. What we would lose is what WfP was going to
  buy: the per-account script cap lifted, per-customer tags for lifecycle, outbound
  workers, per-script limits. That is a scale ceiling, not a launch blocker.

Worth stating plainly either way: **platform-owned deploys are not blocked on this.**
We can already upload an ordinary Worker with our own credentials, which is the whole
of "we do the deploys, not the developers". This spike decides how far that scales and
what the isolation story is — not whether it is possible.

## Afterwards

```sh
node teardown.mjs
cd dispatcher && pnpm run delete
```

Then record the answer as a K-decision in `docs/design/kernel-design.md` and delete
this directory. A spike left lying around gets mistaken for a component.

[b]: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/
[m]: https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
[u]: https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/
[k]: https://developers.cloudflare.com/durable-objects/platform/known-issues/
