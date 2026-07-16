/**
 * The Zod instance these schemas were built with.
 *
 * Import `z` FROM HERE, not from 'zod', whenever you compose a contracts schema
 * into your own — `z.object({ facility: entityRef, unitPrice: money })` is the
 * pattern the engines themselves use, and it is what "parse, don't trust" asks
 * of every operation input.
 *
 * Zod schemas do not compose across copies or majors. A consumer who runs
 * `pnpm add zod` today gets Zod 4 while these schemas are Zod 3, and the mix
 * fails at RUNTIME with `Invalid element at key "…": expected a Zod schema` —
 * an error that points nowhere near the cause. Re-exporting the instance makes
 * the correct choice the easy one.
 */
export { z } from 'zod';

export * from './ids.js';
export * from './tenancy.js';
export * from './control-plane.js';
export * from './permission.js';
export * from './events.js';
export * from './manifest.js';
export * from './money.js';
export * from './attachments.js';
