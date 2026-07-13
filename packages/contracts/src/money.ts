import { z } from 'zod';

// The one money representation (K-14). Decimal strings, never floats — the
// Tier 1 ↔ Tier 2 reconciliation guarantee (plan §5.3) needs uniform,
// exact money handling across every engine. Multi-currency from day one
// (SEK/NOK evidence in the FSM survey).

export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/) // ISO 4217
  .brand<'CurrencyCode'>();
export type CurrencyCode = z.infer<typeof currencyCode>;

export const moneyAmount = z
  .string()
  .regex(/^-?\d+(\.\d{1,6})?$/)
  .brand<'MoneyAmount'>();
export type MoneyAmount = z.infer<typeof moneyAmount>;

export const money = z.object({
  amount: moneyAmount,
  currency: currencyCode,
});
export type Money = z.infer<typeof money>;
