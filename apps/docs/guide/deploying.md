# Deploying a vertical

[Running locally](/guide/running-locally) ends on a promise: the SQLite adapter you run on
your laptop and the Cloudflare adapter you deploy on are the same kernel above
[the scope-host contract](/concepts/scope-host) — *only the composition root changes*. This
page is how you cross that gap. The tool is the **`substrat` CLI**, and the shape of the
crossing is deliberately two moves, not one: a **push** uploads your vertical; an **admission**
lets it serve. They are separate on purpose.

## Push is not deploy

The single idea to hold onto:

> A push lands a **pending** version. Admission — a human decision, in the console — is what
> lets a scope bind it and serve. A push that served without admission would be a way for code
> nobody vetted to reach a production isolate, so there is no such path.

This is the same [two-checkpoint discipline](/concepts/modules#two-human-checkpoints) that
governs migrations and permissions, extended to the deploy boundary. `substrat push` is
something an author (eventually an untrusted, paying *builder*) runs; admission is something the
platform does. The full trust model — why an opaque customer bundle can be accepted at all, and
the [sandbox contract](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md)
that makes it safe — is its own design note. What you need to ship a vertical is below.

One credential principle underpins all of it: **the author never holds a Cloudflare token.** The
control plane holds the Workers-for-Platforms credential and does the upload; the CLI builds
locally and POSTs a bundle. (Decision D-34.)

## Sign in — `substrat login`

The CLI is wired at the repo root as `pnpm substrat`; installed, it is the `substrat` bin.

```bash
substrat login
```

The default is a **browser loopback login**: the CLI starts a one-shot server on `127.0.0.1`,
opens your browser to the control plane's CLI broker (`{cp}/auth/cli`), which signs you in
through [AuthHero](/concepts/identity) and redirects back with a PKCE-bound `code`. The CLI
exchanges the code for a session token and stores it in `~/.substrat/config.json`. The token
never transits a URL — only the code does — and the loopback server accepts exactly one callback,
then closes.

For CI, where there is no browser, store a service credential instead:

```bash
substrat login --token <SERVICE_TOKEN>    # the control plane's service-actor credential
```

Either way, auth resolves in this order at push time: explicit `--token` /
`SUBSTRAT_SERVICE_TOKEN` → a stored browser session → a stored service token. The control-plane
URL resolves `--cp` → `SUBSTRAT_CP_URL` → the stored config (default
`https://console.substrat.net/api`). You are always authenticated **as yourself** — a push is
attributable to the human or service that ran it, never a hand-picked actor.

## Ship it — `substrat push`

```bash
substrat push <verticalDir> --slug <slug> --version <v> [--name <name>]
```

From the vertical's directory (the one with `wrangler.jsonc`), this:

1. **Builds the bundle** with `wrangler deploy --dry-run --outdir` — running your vertical's own
   `build.command` first. workerd cannot bundle in the isolate, so the build always happens on
   your side; the endpoint only ever receives a *built* worker.
2. **Reads your `wrangler.jsonc`** for the declared surface that travels with the bundle: your
   own Durable Object classes, your own D1 databases (e.g. a Better-Auth `AUTH_DB`), the
   compatibility date and flags (a vertical needing `nodejs_compat` can't start without them),
   and the entry module. A vertical's *own* stores travel with it; the platform's do not.
3. **Computes digests** — manifest, permission (from the bindings), migration (from the DO
   classes) — the same digest-diff surface the checkpoints read.
4. **POSTs the bundle + manifest** to `{cp}/verticals/{slug}/deploy`, authenticated with your
   own credential.

The endpoint validates your declared bindings against the sandbox contract — a customer bundle
that tries to declare a `CONTROL_PLANE` binding or a platform secret is refused *before* it
reaches the namespace — uploads to the `substrat-verticals` Workers-for-Platforms namespace under
a `deploymentRef`, and records a **pending** version. It never promotes or binds. On success the
CLI prints the version id, its `pending` admission state, and the `deploymentRef`:

```
✓ pushed. version 01J… is pending; deploymentRef=<builder>-<slug>@<v>
  admit it in the console to let a scope bind it.
```

## Admit it — the console

The pushed version now sits **pending** in the [control-plane console](/platform/console). An
admin admits it (the deliberate human gate), which lets `bindScopeVersion` / `promoteVersion`
attach it to a scope; the [router](/platform/router) then resolves a request's hostname to that
scope and dispatches into the running isolate. `bindScopeVersion` and `promoteVersion` refuse
anything not admitted — the gate is mechanical, the admission is human.

That is the whole path: **push → pending version → admission → bind → serve** — laptop to
production with the author never holding a Cloudflare credential, and no unvetted code ever
reaching a production isolate.

## Where this is going

The foundation above is real and works today for the platform's own verticals (Callout ships
this way). Opening it to *untrusted* builders — inspecting an opaque bundle, or building
customer source in a disposable sandbox so the digest checkpoints become verified rather than
advisory — is the phased work described in the
[self-serve deploy design note](https://github.com/substrat-run/substrat/blob/main/docs/design/self-serve-deploy.md).
