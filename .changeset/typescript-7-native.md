---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/connector-scrive': patch
'@substrat-run/boundary-lint': patch
---

**Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
`tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
public API changes; this bumps the published packages solely because their build now runs
through the native compiler.

Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
0.12s, engine-invoicing 0.91s → 0.06s on this machine).

Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

- **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
  surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
  did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
  `*.css`) — rather than adding a stray `vite-env.d.ts`.
- **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
  `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
  leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
  explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
TS Server on 7 to keep CLI and IDE diagnostics aligned.
