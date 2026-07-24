import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';

/**
 * The Manyfold data API — one route table, adapter- and auth-agnostic. Both entrypoints
 * mount it: `server.ts` (node, pure-SQLite adapter, dev-header auth) and `worker.ts`
 * (Cloudflare, Durable-Object adapter, the vertical's own IdentityDO). Each supplies a
 * `resolveStub` that authenticates the caller AND resolves which SITE (scope) the request
 * targets, then returns a capability `ScopeStub`. Every route is a thin wrapper over one
 * operation — no business logic — so the two entries cannot drift (D-14).
 */
export type ResolveStub = (c: Context) => Promise<ScopeStub>;

/** The vertical's operations, exposed under `/api/op/<name>`. */
export const OPERATIONS = [
  'create-entry', 'save-draft', 'restore-revision', 'submit-for-review', 'approve', 'reject',
  'publish', 'unpublish', 'archive', 'list-entries', 'review-queue', 'get-entry', 'list-types',
  'deliver', 'list-delivery', 'save-type', 'delete-type', 'whoami', 'timeline',
] as const;
const ALLOWED = new Set<string>(OPERATIONS);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApi(app: Hono<any, any, any>, resolveStub: ResolveStub): void {
  // Shared fail-closed error mapping: permission → 403, state-machine/immutability
  // conflicts → 409, missing entity/scope/op → 404, everything else a validation 400.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
    const msg = err instanceof Error ? err.message : String(err);
    if (/invalid transition|frozen|already|cannot edit|cannot restore|not published|in use/.test(msg)) {
      return c.json({ error: msg }, 409);
    }
    if (/not found|unknown (content type|site|operation)|not entitled|unknown scope/.test(msg)) {
      return c.json({ error: msg }, 404);
    }
    return c.json({ error: msg }, 400);
  });

  app.post('/api/op/:op', async (c) => {
    const op = c.req.param('op');
    if (!ALLOWED.has(op)) throw new HTTPException(404, { message: `unknown operation: ${op}` });
    const input = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    return c.json((await (await resolveStub(c)).invoke(`manyfold/${op}`, input)) ?? null);
  });
}
