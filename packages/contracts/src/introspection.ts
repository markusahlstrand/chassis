import { z } from 'zod';

/**
 * Read-only introspection of a scope's own database — the console/dashboard "Data"
 * view (kernel-design §5.4's admin-query RPC, cashed in as two narrow primitives).
 *
 * This is an OPERATOR read, not module code and not an operation: it reaches a
 * scope's SQLite directly through `HostAdmin`, so it takes a `PlatformActorId` and
 * records to the staff access log (K-24) like every other directory read. It is
 * deliberately *read-only and table-shaped* — there is no user-supplied SQL, only a
 * table name validated against the live schema plus a bounded page — so there is no
 * write path to forge the spine and no injection surface to guard.
 */

/**
 * One table in a scope's database. `system` marks the platform's own spine tables
 * (`_substrat_*`) and SQLite internals (`sqlite_*`) so the UI can group them apart
 * from the vertical's own data — reads of them are allowed (projections read the
 * spine); it is only writes the module rules forbid.
 */
export const scopeTable = z.object({
  name: z.string().min(1),
  rowCount: z.number().int().nonnegative(),
  system: z.boolean(),
});
export type ScopeTable = z.infer<typeof scopeTable>;

/**
 * A bounded page of rows from one table. `columns` is the column order; each row in
 * `rows` is a positional array aligned to it (JSON values — SQLite text/int/real/
 * null/blob-as-null). `rowCount` is the table's TOTAL row count, so the UI can page.
 */
export const scopeTablePage = z.object({
  table: z.string().min(1),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ScopeTablePage = z.infer<typeof scopeTablePage>;

// The default and hard ceiling on a page — a browser reads a screenful, never the
// whole table, and the ceiling is what keeps a scope's DB read from becoming a dump.
export const SCOPE_TABLE_PAGE_DEFAULT = 50;
export const SCOPE_TABLE_PAGE_MAX = 200;

/**
 * What `readScopeTable` accepts. `table` is validated against the live schema by the
 * adapter (an unknown name is rejected, never interpolated). `limit` is clamped to
 * [1, SCOPE_TABLE_PAGE_MAX]; `offset` is a non-negative row offset for paging.
 */
export const readScopeTableInput = z.object({
  table: z.string().min(1),
  limit: z.number().int().positive().max(SCOPE_TABLE_PAGE_MAX).default(SCOPE_TABLE_PAGE_DEFAULT),
  offset: z.number().int().nonnegative().default(0),
});
export type ReadScopeTableInput = z.infer<typeof readScopeTableInput>;
