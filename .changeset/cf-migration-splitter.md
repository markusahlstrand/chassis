---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

**Fix: a migration whose comment or string literal contains a semicolon no longer fails only on
Durable Objects.**

The two scope-host adapters applied module migrations differently, and that divergence was a
latent trap:

- the **SQLite** adapter hands the whole migration blob to better-sqlite3's `exec`, which parses
  comments, string literals, and multiple statements correctly;
- the **Cloudflare** adapter ran `migration.sql.split(';')` and `exec`'d each fragment — a naive
  split that truncates a statement the moment a `;` appears inside a `--` / `/* */` comment or a
  string literal. SQLite then reports `incomplete input`.

So a migration could be **green on every node test and CI run, then fail only on `workerd`** in
production. (Found porting Meridian to Cloudflare: an `hr_absence_ledger` column comment read
`-- signed decimal days; balance = SUM(delta)` and broke `CREATE TABLE`.)

The fix replaces the naive split with `splitSqlStatements` — a small SQL-aware scanner that skips
line and block comments, copies string literals through verbatim (including the `''` escape), and
splits only on a top-level `;`. Comments are dropped from emitted statements, so a trailing
comment can never become a comment-only fragment that `exec` rejects either.

To make the class of bug unmissable and keep the adapters from diverging again, the shared
contract-test module `testMod`'s migration now deliberately contains all the hard cases — a `;` in
a line comment, in a block comment, and in a string-literal `DEFAULT`, plus a second statement.
Every suite that provisions a scope therefore exercises it on **both** adapters; a naive splitter
fails provisioning outright. `splitSqlStatements` also has direct unit coverage of each edge case.
