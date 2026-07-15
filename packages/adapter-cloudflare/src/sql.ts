import type { ScopedSql, SqlValue } from '@substrat-run/kernel';

/**
 * Adapts a Durable Object's `SqlStorage` to the kernel's `ScopedSql` contract
 * (`query`/`exec`). DO SQL is synchronous — `exec` returns a cursor eagerly —
 * so this mirrors the better-sqlite3 wrapper in `adapter-sqlite` one-to-one.
 *
 * Note (from the step-0 spike): the DO runtime FORBIDS manual `BEGIN`/`COMMIT`
 * via SQL and directs callers to `storage.transactionSync()`, which auto-rolls
 * back on a synchronous throw but commits at the first `await`. The ScopeDO
 * therefore brackets each operation's synchronous execution in `transactionSync`
 * and buffers emitted events until success — it never issues raw transaction SQL.
 */
export function doScopedSql(sql: SqlStorage): ScopedSql {
  return {
    query: <T = Record<string, SqlValue>>(q: string, params: readonly SqlValue[] = []): T[] =>
      sql.exec(q, ...(params as SqlValue[])).toArray() as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => {
      const cursor = sql.exec(q, ...(params as SqlValue[]));
      return { changes: cursor.rowsWritten };
    },
  };
}
