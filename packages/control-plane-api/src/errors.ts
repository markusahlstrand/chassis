import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Map an adapter throw onto an HTTP status.
 *
 * `HostAdmin` throws plain `Error`s — deliberately, so their messages survive
 * the Cloudflare RPC hop intact (a ZodError would not). That leaves this layer
 * matching on message text, which is the weakest seam in this package and worth
 * naming rather than hiding:
 *
 * - It is less brittle than it looks. Every pattern below is a message the
 *   CONTRACT SUITE asserts on (`/unknown tenant/`, `/illegal scope transition/`,
 *   `/already taken/`, `/not active/`), against both adapters. Changing one
 *   turns a contract test red, not just this mapping.
 * - It is still text. The durable fix is typed errors on `HostAdmin` — a tagged
 *   union the adapters throw and this reads. That is a kernel change, and it is
 *   not worth blocking the transport on.
 *
 * Anything unmatched is a 500 with a GENERIC body: an unrecognised throw is, by
 * definition, one whose message we have not reviewed for what it discloses, and
 * this surface has cross-tenant reach.
 */
/**
 * ORDER IS SIGNIFICANT — first match wins, so every specific pattern must precede
 * the general one it would otherwise be swallowed by. `cannot provision scope
 * under unknown tenant` contains `unknown tenant:`, and listing the general one
 * first turned a precondition conflict into a 404 claiming POST /scopes does not
 * exist. That is the message-matching fragility this file admits to above, caught
 * by the test below rather than by reading.
 */
const STATUS_PATTERNS: readonly [RegExp, ContentfulStatusCode][] = [
  // Well-formed, but conflicts with current state or references something absent.
  // The addressed collection exists; the request cannot be applied to it.
  [/cannot provision scope under unknown tenant/, 409],
  [/already taken/, 409],
  [/illegal scope transition/, 409],
  [/non-active tenant/, 409],
  [/not active \(status:/, 409],
  // Registry (#31): well-formed, but conflicts with a version's admission state or
  // ownership, or needs an unacknowledged change acknowledged (the two checkpoints).
  [/is already registered/, 409],
  [/was rejected — publish a new one/, 409],
  [/is already admitted/, 409],
  [/belongs to '/, 409],
  [/not admitted/, 409],
  [/acknowledge it explicitly to promote/, 409],
  // The ADDRESSED resource does not exist — including the K-3 fail-closed case
  // where it exists under a DIFFERENT tenant and must read as absent.
  [/unknown tenant:/, 404],
  [/unknown scope for tenant/, 404],
  [/unknown scope /, 404],
  [/unknown vertical /, 404],
  [/unknown version /, 404],
  [/scope has no tenant record/, 404],
];

export interface ApiError {
  status: ContentfulStatusCode;
  body: { error: string };
}

export function mapError(err: unknown): ApiError {
  const message = err instanceof Error ? err.message : String(err);
  for (const [pattern, status] of STATUS_PATTERNS) {
    if (pattern.test(message)) return { status, body: { error: message } };
  }
  return { status: 500, body: { error: 'internal error' } };
}
