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
