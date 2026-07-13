# Money

Substrat ships **one money representation** and one sanctioned way to compute with it,
because "every engine invents its own money handling" is how reconciliation dies.

## The representation

```ts
import { money, moneyOf, type Money } from '@substrat/contracts';

type Money = {
  amount: MoneyAmount;     // decimal string, up to 6 dp — never a float
  currency: CurrencyCode;  // ISO 4217: 'SEK', 'NOK', 'EUR'…
};

const price = moneyOf('1250.50', 'SEK');
```

- **Decimal strings, never floats.** `0.1 + 0.2` problems cannot enter the system;
  amounts survive JSON round-trips exactly.
- **Branded types.** A random string won't typecheck as a `MoneyAmount`; parse it.
- **Multi-currency from day one.** Currency is part of the value, and mixing currencies
  throws.

## The arithmetic

All computation happens on micro-units (6 decimal places, `bigint`) with half-up
rounding at the 6th decimal — exact, deterministic, overflow-free:

```ts
import { addMoney, mulMoney, addDecimal, mulDecimal, compareDecimal } from '@substrat/contracts';

addMoney(a, b);            // Money + Money (throws on currency mismatch)
mulMoney('2.5', hourlyRate); // quantity × unit price → Money
addDecimal('10.1', '0.2');   // '10.3' — plain decimal strings
compareDecimal(a, b);        // -1 | 0 | 1
```

This is the **only** sanctioned way engines compute with money. If you find yourself
calling `parseFloat` on an amount, stop.

## Why it's this strict

The system's standing integrity guarantee is that **reported totals reconcile with
transactional truth** — a reconciliation job continuously verifies that sums derived
from the event stream match the balances in scope databases. That guarantee is only as
good as the weakest arithmetic in any engine, which is why the arithmetic lives in
`@substrat/contracts` and not in each engine's utils file.

You can see the discipline in the engines: the work-order engine sums billable lines
with `addMoney`; the invoicing engine stores `amount`/`currency` as separate columns and
totals lines with `addDecimal`. Same primitives, same rounding, same results —
reconcilable by construction.
