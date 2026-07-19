/**
 * The stand-in for a customer's vertical, as a Workers-for-Platforms user worker.
 *
 * It is deliberately shaped like a real one, because the question is not "does WfP
 * run code" — it is whether WfP runs OUR code. A Substrat vertical is not a worker
 * that talks to a Durable Object; it is a worker that DEFINES one, because
 * `defineScopeDO(MODULES)` puts kernel, engines and module code inside the DO. So
 * this exports a SQLite-backed DO class, binds to it, and does a real write and
 * read through it.
 *
 * Anything less would prove less. An upload that is accepted is not evidence that
 * the class instantiates, and a DO that instantiates is not evidence that SQLite
 * storage works in a dispatch namespace — which is the storage every scope uses.
 */

export class ScopeDO {
  constructor(ctx) {
    this.ctx = ctx;
    // Same shape as the real adapter: schema on construction, SQL through the
    // DO's own SQLite. If `sql` is undefined here, the class was created without
    // SQLite storage and `new_sqlite_classes` did not take effect.
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS probe (k TEXT PRIMARY KEY, v TEXT)');
  }

  async fetch(request) {
    const scope = new URL(request.url).searchParams.get('scope') ?? 'unknown';
    this.sql.exec('INSERT OR REPLACE INTO probe (k, v) VALUES (?, ?)', 'scope', scope);
    const rows = [...this.sql.exec('SELECT v FROM probe WHERE k = ?', 'scope')];
    return Response.json({
      wrote: scope,
      readBack: rows[0]?.v ?? null,
      // Proof it is per-instance durable state and not a lucky in-memory hit.
      id: this.ctx.id.toString(),
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope') ?? 'scope-a';
    // One DO per scope, by name — the addressing the kernel actually uses.
    const stub = env.SCOPE.get(env.SCOPE.idFromName(scope));
    const res = await stub.fetch(new Request(`https://do/?scope=${encodeURIComponent(scope)}`));
    const body = await res.json();
    return Response.json({ ok: true, via: 'user-worker', ...body });
  },
};
