# Demo Vertical — "Kallkälla Kaffe" (e-commerce stress test)

Status: draft v0.1 · Last updated: 2026-07-15

> A third vertical whose job is different from the first two. ServiceCo
> ([demos/fsm](../../fsm/spec/concept.md)) and CykelService ([demos/bike-shop](../../bike-shop/spec/concept.md))
> are both **work-order-shaped** — they prove *same engine, new vocabulary*. This one is
> a **different domain** (retail) that (a) reuses `engine-invoicing` across that domain
> boundary and (b) introduces a **new class of invariant** the current engines don't have:
> **stock reservation / no-oversell under concurrency**. It's the honest benchmark: the one
> domain where cross-vertical commerce modules are known to work (master-plan decision 27,
> "no precedent outside e-commerce"; Medusa the cited analogue).

## 1. What this demo must prove (beyond the first two)

1. **A published engine reused across a genuinely different domain.** `engine-invoicing`
   builds a fakturaunderlag from a **retail order**, not a service work order — the
   star-topology reuse the two repair shops can't demonstrate.
2. **Additive engine evolution, on stage.** Invoicing learns a *second* input event
   (`commerce.order-placed`) **additively** — new `consumes` entry + a second consumer with
   its own Zod parse. The existing `workorder.completed` path is untouched and frozen. This
   is the "surfaces evolve additively only" rule, performed.
3. **A new invariant shape holds: no oversell.** Two concurrent checkouts race for the last
   unit; exactly one wins, enforced inside a single `ctx.sql` transaction. This is *not* a
   state machine — it's a reservation ledger, and it's the thing that would break a weaker
   composition model.
4. **The three-layer split survives retail.** Catalog, variants, pricing, discounts, screens
   are 100% vertical. The engine owns only the money-basis snapshot. Nothing retail-specific
   leaks into `engine-invoicing`.

## 2. The firm & the rival

**Kallkälla Kaffe AB** — a small-batch coffee roaster in Stockholm with a web shop. Sells
beans (variants: hela bönor / malet × 250 g / 1 kg) and brewing gear. A single roastery
means genuinely **scarce stock** — a limited micro-lot drop is the natural setting for the
oversell beat. Customers can check out **mot faktura** (invoice payment — ubiquitous in
Swedish B2B/B2C via Klarna/Qliro), which is what produces a fakturaunderlag. Card/Swish
would be a payment **connector**, deliberately deferred.

**Bönfeber Rosteri AB** (tenant B) exists only to give the cross-tenant attack a perpetrator.

## 3. The cast

| Who | Role | Must be able to | Must be denied |
|---|---|---|---|
| **Astrid** | butiksägare (shop-admin, tenant-level) | everything: catalog, prices, stock, discounts, fulfil orders, invoicing | — |
| **Gustav** | lagermedarbetare (warehouse) | adjust stock, pick/pack (fulfil) | set prices, create discounts, invoicing |
| **Shopper** (public/anon) | storefront principal | browse published catalog, build a cart, place an order **for its own cart only** | see other carts/orders, any admin op, any write to stock/prices |
| **Elin** | portal customer (wholesale café) | see exactly her own orders, reorder | Otto's orders, invoicing, any admin write |
| **Otto** | portal customer | see exactly his own orders | Elin's orders |
| **Rurik** | shop-admin of *Bönfeber* (tenant B) | everything in his own tenant | anything in tenant A: `unknown scope` on a forged pair, `permission denied` on every op |

The **Shopper** principal is itself a stress test: a near-zero-privilege actor whose only
reach is its own cart (per-entity `ctx.check(perm, cartRef)` — a proof walk, not UI
filtering), and the oversell race is between two concurrent Shopper carts.

## 4. Vocabulary mapping

| Kallkälla says | Maps to | Notes |
|---|---|---|
| Produkt | vertical `shop_products` | catalog vocabulary — vertical-owned |
| Variant (malning × storlek) | vertical `shop_variants` (sku, price, stock) | Cartesian of options; vertical-owned |
| Lagersaldo | `shop_stock` (on_hand) + `shop_reservations` | **invariant: no oversell** (§6) |
| Varukorg | `shop_carts` + `shop_cart_lines` | ephemeral, mutable |
| Order | `shop_orders` + `shop_order_lines` | **immutable after placement** (§6) |
| Rabattkod | `shop_discounts` | vertical vocabulary + the pricing moment (§5) |
| Kund | `shop_customers` ref | portal grants entity-narrowed to the customer |
| Fakturaunderlag | **`engine-invoicing` underlag** | built from `commerce.order-placed` — reuse + additive consume (§7) |

Link edges this vertical declares: `cart → customer` (or session), `order → customer`,
`order → cart` (provenance). The permission walk the portal follows: `order → customer`.

## 5. The vertical-owned moment (pricing + discounts)

At checkout, in **one transaction**, the vertical: reads the cart lines → applies the price
list and any **rabattkod** → computes line and order totals → freezes them onto the order.

- Discount types: **percentage** and **fixed-amount**, with **min-spend**, **validity
  window**, and a **usage cap**. An expired or over-used code is rejected; a below-min-spend
  code does not apply.
- All money is decimal **strings** via `@substrat-run/contracts` (`mulMoney`, `addDecimal`,
  `compareDecimal`) — never floats. Test asserts totals exact to the öre.

## 6. The invariants — **vertical code now, engine at the *second* commerce vertical (D-27)**

Per decision 27 (engines are extracted at the second vertical, never designed ahead — the
exact pattern the FSM spec applies to protocols), these live as `shop/*` operations now. The
spec names the extraction seam so the future `engine-inventory` / `engine-order` is obvious,
but we do **not** build it ahead of a second retail vertical forcing it.

1. **No oversell.** `reserve(cart, variant, qty)` succeeds only if
   `on_hand − Σ(active reservations) ≥ qty`, computed and written in one `ctx.sql`
   transaction; otherwise it throws `OutOfStock`. Placement converts reservations to sold
   and decrements `on_hand`.
   - **Reservation TTL without a background job** (the genuine design question this demo
     exists to answer): reservations **expire lazily**. "Available" is *always* computed as
     `on_hand − Σ(reservations WHERE expires_at > now)`; expired rows are ignored on read and
     swept opportunistically on the next write to that variant. No timer, no cron, no module
     code reaching across a boundary — which is what a weaker model would need. If this reads
     cleanly, the thesis holds; if it's awkward, **that is the most valuable finding.**
   - *Adapter honesty:* on the pure-SQLite host writes serialize per scope, so the atomicity
     is real but uncontended. The test still asserts the invariant (second reserve of the
     last unit throws); the concurrency claim is about the *transaction boundary*, not
     parallelism the single-writer adapter doesn't have. Flagged, not hidden.
2. **Order immutable after placement.** State machine `cart → placed → fulfilled → closed`
   (plus `cancelled` from `cart`/`placed`), no skips. Once `placed`, order lines and totals
   are frozen — any write to a placed order's lines throws, exactly like an exported underlag.

## 7. Reuse + additive evolution of `engine-invoicing`

The vertical emits a **fat** `commerce.order-placed` event (everything invoicing needs, no
cross-module read). Invoicing gains, **additively**:

- `events.consumes += { type: 'commerce.order-placed', schemaVersion: 1 }`
- a **second** `ConsumerHandler` with its **own** Zod parse mapping order lines → billable
  lines (`sourceType: 'order-line'`), producing the same `invoicing_underlag` / `invoicing_lines`
  rows — **snapshot, not join**, provenance back to the order via `EntityRef`.

No new invoicing tables, no new permissions, no change to the `workorder.completed` path. It
demonstrates the additive-evolution rule and cross-domain reuse in the same beat. Only orders
paid **mot faktura** produce an underlag; card/Swish orders would settle through a payment
connector (deferred).

> **Decision for review — invoicing reuse touches the published engine.** Adding the second
> consumer edits an AGPL package (`engines/invoicing`). It's additive and checkpoint-light (no
> migration, no permission). The alternative is to build the invoice basis fully in-vertical
> and forgo the reuse proof. **Recommended: do the additive consume** — the reuse + additive
> evolution is the headline this demo exists to show. Flagged here rather than assumed.

## 8. The vertical's own tables

`shop_products`, `shop_variants` (sku unique, price_amount TEXT, currency), `shop_stock`
(variant_id, on_hand), `shop_reservations` (id, cart_id, variant_id, qty, expires_at),
`shop_carts`, `shop_cart_lines`, `shop_orders` (status, totals frozen at placement, payment
method), `shop_order_lines`, `shop_discounts` (code, kind, value, min_spend, valid_to,
uses_remaining), `shop_customers`. All ids TEXT `ulid()`; all money/decimals TEXT; all
timestamps ISO-8601 TEXT. Append-only migrations, prefix `shop_`.

## 9. The scenario the test replays

1. Migrations journaled; permission diff and migration diff are the two checkpoints.
2. **Happy path:** Astrid publishes a micro-lot with `on_hand = 1` → Shopper A reserves it →
   **Shopper B's reserve of the same last unit throws `OutOfStock`** (the money beat) →
   Shopper A checks out **mot faktura** with a valid rabattkod → order `placed`, lines frozen
   → `commerce.order-placed` on the spine → **invoicing underlag line appears** with
   drill-down provenance to the order → editing the placed order's lines is **blocked**.
3. **Denials (not optional — they are the demo):** Gustav adjusts stock but is denied setting
   a price / creating a discount / reading invoicing; Elin sees her orders only, never Otto's;
   Rurik (tenant B) gets `unknown scope` on a forged pair and `permission denied` on every op
   against tenant A.
4. **Pricing math** exact to the öre; expired code rejected; usage-cap exhaustion rejected;
   below-min-spend code does not apply.
5. **Reservation TTL:** advance the clock past `expires_at` → the reserved unit is available
   again on the next read (lazy expiry), and a fresh reserve now succeeds.
6. **State machine** can't skip (`cart → fulfilled` without `placed` throws).

## 10. Build order

1. Vertical skeleton (`@substrat-run/demo-shop`, private; API :8789, web :5175; principal
   picker localStorage key `shop`).
2. `shop/*` module: catalog + variants + stock, the reservation ledger, cart, the
   checkout/pricing moment emitting `commerce.order-placed`, the order state machine.
3. Additive second consumer in `engine-invoicing` (§7).
4. Seed world: two tenants, the cast, entity-narrowed portal grants, a micro-lot with
   `on_hand = 1` for the oversell beat.
5. Scenario test (§9) — denials and the oversell throw are the acceptance bar.
6. App skin: storefront (browse → cart → checkout) + admin (catalog, stock, orders,
   underlag review), copy-and-own from `demos/fsm/app`.

**Deferred, deliberately (all "provider/connector" per the landscape survey):** payment
capture (Swish/card), tax calculation, shipping rates/carriers, multi-warehouse, returns/
exchanges. Faking them proves nothing about the engine model; Medusa, Shopify, and Brink all
treat them as provider territory too.

## 11. Definition of done

An agent scaffolds the vertical to the two checkpoints without further prompting; the oversell
reserve throws; every denial vector fails closed; the invoicing underlag is built from the
retail event with `workorder.completed` untouched; pricing is exact to the öre; the scenario
runs start-to-finish on pure SQLite with no network.
