# Licensing

Substrat is **dual-licensed**. Every package carries its license in `package.json` and
ships the full text in its tarball.

## The model

| Component | License | Why |
|---|---|---|
| `@substrat-run/contracts` (and the future SDK) | **Apache-2.0** | The product *interface*. Verticals import these; building against Substrat must never copyleft-capture your application. Maximum diffusion is the point — the moat is runtime enforcement, not schema files. |
| `@substrat-run/kernel`, `@substrat-run/adapter-sqlite`, `@substrat-run/adapter-cloudflare`, `@substrat-run/contract-tests` | **AGPL-3.0-only** + commercial | The substrate itself. AGPL makes the self-host/escrow story real — you can always run the kernel yourself — while requiring that proprietary derivatives and hosted offerings either open their changes or hold a commercial license. |
| `@substrat-run/control-plane-api` | **AGPL-3.0-only** + commercial | The audited admin surface over the kernel's `HostAdmin` — tenant registry, scope lifecycle, entitlements, the admin log. Same terms as the substrate, and the clearest case for AGPL rather than a permissive licence: it is served *over a network*, which is exactly what §13 is about. Self-hosting it is part of the escrow guarantee; running a modified one as a hosted offering means publishing the modifications or holding a commercial licence. |
| `@substrat-run/engine-*` | **AGPL-3.0-only** + commercial | Engines are independently licensable modules; same terms as the kernel. |
| `demos/*`, `apps/*` | Private, unpublished | Not licensed for distribution. |

## What this means in practice

- **Building a vertical on the hosted platform**: your code is yours. You import
  Apache-licensed contracts/SDK; the AGPL kernel runs on our side of the network
  boundary under the commercial/hosted terms.
- **Self-hosting under AGPL**: fully allowed — that is the escrow guarantee. If you
  modify the kernel or engines and offer them over a network, AGPL §13 requires you to
  publish those modifications.
- **Proprietary self-host / embedding without copyleft obligations**: requires a
  commercial license — contact the maintainers.

## Contributions

Dual licensing requires unified copyright. All contributions are accepted under a
Contributor License Agreement granting the project the right to license the
contribution under both the open-source and commercial terms (formal CLA flow to be
added before external contributions are accepted — see the master plan's governance
section).

## Copyright

Copyright © 2026 Markus Ahlstrand. (The kernel's eventual legal home — own entity vs
existing holding — is an open item in the master plan §11; the copyright line follows
that decision when made.)
