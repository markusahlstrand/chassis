import { platformActorId, type PlatformActorId } from '@substrat-run/contracts';

/**
 * The identity seam for the control plane (control-plane.md §6).
 *
 * The data model needs to know THAT there is an actor, not HOW it authenticated
 * — so this whole surface is buildable and testable against a stub while real
 * staff auth (SSO, MFA, short sessions, a small closed population) is designed.
 * D-16 commits to identity being a swappable adapter; this is that being cashed
 * in for platform staff rather than tenant users.
 *
 * Returning null means "not authenticated" and the request is refused. There is
 * no "anonymous actor" — §4.4's whole point is that a surface which can act
 * without a durable record of WHO acted is worse than no surface, and an actor
 * the log cannot name is exactly that.
 */
export type PlatformActorAuth = (request: Request) => Promise<PlatformActorId | null> | PlatformActorId | null;

/** Header the dev stub reads. Mirrors the demos' `x-principal` dev affordance. */
export const DEV_ACTOR_HEADER = 'x-platform-actor';

/** Header a SERVICE (a vertical registering itself) presents — not a staff subject. */
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * A service credential (open decision 2): a shared bearer token that resolves to
 * a fixed service actor. This is how a *vertical* authenticates to the control
 * plane to register its tenant/scope — distinct from staff, who sign in. An
 * absent or empty token never matches; comparison is length-checked and
 * constant-ish to avoid the trivial timing leak.
 */
export function serviceTokenAuth(token: string, actor: PlatformActorId): PlatformActorAuth {
  return (request) => {
    const presented = request.headers.get(SERVICE_TOKEN_HEADER);
    if (!presented || !token || presented.length !== token.length) return null;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0 ? actor : null;
  };
}

/** Try each auth in order; first non-null actor wins, else null (fail closed). */
export function firstPlatformActorAuth(...auths: PlatformActorAuth[]): PlatformActorAuth {
  return async (request) => {
    for (const auth of auths) {
      const actor = await auth(request);
      if (actor) return actor;
    }
    return null;
  };
}

/**
 * A dev stub that trusts an `x-platform-actor` header verbatim.
 *
 * UNSAFE_ by name, deliberately — it is the same convention the kernel uses for
 * `UNSAFE_allowAllChecker`, and for the same reason: an unsafe default that is
 * merely *documented* gets shipped, while one that must be typed out in the
 * caller's own code gets noticed in review.
 *
 * **Never expose this on a non-local listener.** control-plane.md §6: real auth
 * gates EXPOSING the console, not BUILDING it — nothing with cross-tenant reach
 * goes anywhere non-local on a stub. The demos' `x-principal` header is a dev
 * affordance for ONE tenant's principal; this header names a subject with reach
 * across every tenant on the platform, so "a super-admin on top of it is a
 * liability, not a milestone".
 *
 * It still parses: a header that is not a ULID is rejected rather than written
 * into the audit log, because a malformed actor makes the trail unreadable
 * exactly when it matters.
 */
export function UNSAFE_devPlatformActorAuth(): PlatformActorAuth {
  return (request) => {
    const raw = request.headers.get(DEV_ACTOR_HEADER);
    if (!raw) return null;
    const parsed = platformActorId.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
}

/**
 * The authenticated staff identity a session reader returns. `email` is the
 * stable key an actor resolver maps to a `PlatformActorId`; that is all the data
 * model needs from the auth provider (D-16 — identity is a swappable adapter).
 */
export interface StaffIdentity {
  email: string;
}

/** Reads the current staff identity from a request's headers/cookies, or null. */
export type StaffSessionReader = (
  headers: Headers,
) => Promise<StaffIdentity | null> | StaffIdentity | null;

/**
 * Maps an authenticated staff identity to its audited `PlatformActorId`, or null to
 * refuse. May be async: a roster that lives in a database — which is what makes
 * "who has platform access" answerable and revocable without a deploy — cannot
 * answer synchronously.
 */
export type StaffActorResolver = (
  identity: StaffIdentity,
) => PlatformActorId | null | Promise<PlatformActorId | null>;

/**
 * The real `PlatformActorAuth`: an authenticated session → a platform actor. This
 * is the seam §6 asks for, split so the AUTH PROVIDER and the STAFF ROSTER are
 * independent. `readSession` wraps whatever proves identity (Better Auth today,
 * AuthHero or an OIDC IdP later — swapping it is the whole migration);
 * `resolveActor` decides who counts as staff and under which actor id.
 *
 * A session with no matching actor returns null — authenticated is not authorized.
 * There is no ambient default: a subject the audit log cannot name does not act.
 */
export function sessionPlatformAuth(
  readSession: StaffSessionReader,
  resolveActor: StaffActorResolver,
): PlatformActorAuth {
  return async (request) => {
    const identity = await readSession(request.headers);
    if (!identity) return null;
    return await resolveActor(identity);
  };
}

/**
 * A `StaffActorResolver` over a fixed roster — the "small closed population" §6
 * names. Email → actor, case-insensitive; anyone not listed is refused. Being an
 * explicit list is the point: staff membership is a decision, not a default, and
 * it is the same shape whichever provider authenticates the email.
 */
export function staffAllowlist(
  entries: ReadonlyArray<{ email: string; actor: PlatformActorId }>,
): StaffActorResolver {
  const map = new Map(entries.map((e) => [e.email.toLowerCase(), e.actor]));
  return (identity) => map.get(identity.email.toLowerCase()) ?? null;
}
