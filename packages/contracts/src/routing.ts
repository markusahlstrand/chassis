import { z } from 'zod';
import { instant, scopeId, slug, tenantId } from './ids.js';

/**
 * The hostname map (K-26; control-plane.md §4.7).
 *
 * §4.2 provisions a scope; nothing gave it a URL. This is the directory data a
 * single environment-wide router resolves against — `hostname → (tenant, scope,
 * vertical, surface, region)` — before dispatching to the vertical's worker.
 */

/**
 * Which app answers on this hostname.
 *
 * §5.5 originally specified one hostname per scope, which is already wrong: the
 * shop fronts a storefront AND a back office from ONE scope, and RallyPoint a
 * player app and a manager console. Same data, different audience and chrome — the
 * split is deliberate and never a second source of truth.
 *
 * Vertical vocabulary, deliberately: the kernel never branches on it, exactly as it
 * never branches on `scope.kind`. It is carried so the router knows where to send
 * the request, and the vertical decides what that name means.
 */
export const surfaceName = z.string().min(1).max(32);

/**
 * Where the hostname's traffic may be processed.
 *
 * The DO jurisdiction (K-7) pins storage and execution and is fixed at
 * provisioning. This is the OTHER half: Cloudflare's Regional Services pins TLS
 * termination and processing, and it is configured **per hostname** — which is why
 * residency is one more column here rather than a router deployed per region.
 *
 * Null means unconstrained. Widening beyond `eu` is additive when a customer needs
 * it; Cloudflare also offers `us` and `fedramp`.
 */
export const hostnameRegion = z.enum(['eu']).nullable();
export type HostnameRegion = z.infer<typeof hostnameRegion>;

/**
 * Where a hostname is in its provisioning lifecycle (§4.2).
 *
 * Custom domains ride Cloudflare for SaaS, so a hostname is not a string somebody
 * sets — it is DNS validation and certificate issuance, which take time and can
 * fail. Treating it as a column would make "the domain does not work yet" and "the
 * domain is broken" the same state.
 *
 * `pending`   — recorded, nothing asked of Cloudflare yet
 * `verifying` — DNS validation and cert issuance in flight
 * `active`    — serving
 * `failed`    — validation or issuance failed; `note` says why
 */
export const hostnameStatus = z.enum(['pending', 'verifying', 'active', 'failed']);
export type HostnameStatus = z.infer<typeof hostnameStatus>;

/**
 * A hostname, normalized to lower case.
 *
 * DNS is case-insensitive, so `ACME.example.com` and `acme.example.com` are the same
 * name — and if the map stored them as two rows, the global-uniqueness check would
 * let two different scopes each hold "the same" hostname, and a request would resolve
 * to whichever casing it happened to arrive in. Normalizing in the schema means both
 * adapters inherit it rather than each remembering to.
 *
 * 253 is the maximum length of a fully-qualified domain name.
 */
export const hostname = z.string().min(1).max(253).toLowerCase();

export const hostnameBinding = z.object({
  hostname,
  tenantId,
  scopeId,
  /** Denormalized from the scope, so the router resolves in one read. */
  verticalSlug: slug.nullable(),
  surface: surfaceName,
  region: hostnameRegion,
  status: hostnameStatus,
  /** Why it failed, when it did. Null otherwise. */
  statusNote: z.string().nullable(),
  /**
   * The one hostname a surface redirects to and issues certs for. Exactly one per
   * (scope, surface) may hold it — the rest are aliases.
   */
  canonical: z.boolean(),
  createdAt: instant,
});
export type HostnameBinding = z.infer<typeof hostnameBinding>;

export const bindHostnameInput = hostnameBinding.pick({
  hostname: true,
  tenantId: true,
  scopeId: true,
  surface: true,
  region: true,
  canonical: true,
});
export type BindHostnameInput = z.infer<typeof bindHostnameInput>;

/**
 * What the router needs to dispatch. Deliberately smaller than the full binding: a
 * per-request hot path should read what it uses and nothing else.
 */
export const routeTarget = z.object({
  tenantId,
  scopeId,
  verticalSlug: slug.nullable(),
  surface: surfaceName,
  region: hostnameRegion,
});
export type RouteTarget = z.infer<typeof routeTarget>;
