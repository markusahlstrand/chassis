import type { PrincipalId, ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * Client for the Dashboard worker's own API (apps/dashboard/src/worker.ts).
 *
 * The worker serves everything under `/api`: `/api/me` (who am I — and, on first
 * call, bootstraps my tenant), `/api/catalog`, `/api/apps`. Auth is an OIDC
 * redirect to the platform's AuthHero instance — there is no password here, so
 * sign-in/out are full-page navigations, not fetches. `credentials: 'include'`
 * carries the same-origin session cookie the worker sets.
 *
 * Only the M0 surface is real; the rest of the Dashboard runs on demo data (see
 * lib/demo.ts) with the honesty banners the design calls for.
 */

/** One team (tenant) the signed-in user belongs to — drives the team switcher. */
export interface Team {
  id: TenantId;
  name: string;
  slug: string;
}

/** Authenticated, but not in any team yet — the app shows the onboarding screen. */
export interface Onboarding {
  needsOnboarding: true;
  email?: string | null;
  name?: string | null;
}

/** The `/api/me` result: either a resolved account, or a teamless login to onboard. */
export type MeResult = Me | Onboarding;

/** Narrow a `MeResult` to the teamless onboarding state. */
export function needsOnboarding(m: MeResult): m is Onboarding {
  return (m as Onboarding).needsOnboarding === true;
}

/** Who the authenticated customer is — their current team, dashboard scope, principal. */
export interface Me {
  principal: PrincipalId;
  /** The currently-selected team (tenant) this session is scoped to. */
  tenant: TenantId;
  dashboardScope: ScopeId;
  /** From the OIDC session — shown in the shell (footer, user pill). */
  email?: string | null;
  name?: string | null;
  /** Every team this login belongs to — one user can span several teams. */
  teams: Team[];
  /** The selected team's id (mirrors `tenant`); drives the switcher's checkmark. */
  currentTeamId: TenantId;
}

export interface CatalogEntry {
  slug: string;
  name: string;
}

/** A team roster entry — an active member or an outstanding invite. Mirrors the worker's row. */
export interface Member {
  id: string;
  /** The kernel principal once accepted; null while still 'invited'. */
  principal: string | null;
  email: string;
  role_key: string;
  status: 'active' | 'invited' | 'revoked';
  invitation_id: string | null;
  invited_by: string;
  invited_at: string;
  joined_at: string | null;
}

/** The role a new member can be invited at (owner is the un-invitable first member). */
export type InviteRole = 'admin' | 'member' | 'viewer';

/** One provisioned app — mirrors the worker's `DashboardAppRow` (module.ts). */
export interface AppRow {
  id: string;
  app_scope_id: string;
  vertical_slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed';
  hostname: string | null;
  created_by: string;
  created_at: string;
}

/** One version of a deployed vertical — mirrors the worker's DeploymentVersion. */
export interface DeploymentVersion {
  id: string;
  version: string;
  admission: 'pending' | 'admitted' | 'rejected' | string;
  admissionNote: string | null;
  deploymentRef: string | null;
  createdAt: string;
}

/** A vertical this tenant pushed — the Deployments view's row (builder-plane.md Phase 4). */
export interface Deployment {
  slug: string; // full registry id, e.g. `acme-co/helpdesk`
  displaySlug: string; // bare name for display, `helpdesk`
  name: string;
  source: string;
  versions: DeploymentVersion[];
  channels: Array<{ channel: string; versionId: string }>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string>) },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  /** `null` when there is no session (the worker answers 401); onboarding when teamless. */
  me: async (): Promise<MeResult | null> => {
    try {
      return await call<MeResult>('/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  /** Create a team (first team or another); the server switches to it, so reload after. */
  createTeam: (name: string) =>
    call<{ teamId: string }>('/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  /** Switch the active team; the server pins it in a cookie, so the caller reloads after. */
  switchTeam: (teamId: string) =>
    call<void>('/teams/switch', { method: 'POST', body: JSON.stringify({ teamId }) }),
  /** Leave the current team (detaches your login); reload after — you'll land in another
   *  team or onboarding if it was your last. */
  leaveTeam: () => call<void>('/teams/leave', { method: 'POST' }),
  catalog: () => call<CatalogEntry[]>('/catalog'),
  /** The current team's roster (active members + outstanding invites). */
  listMembers: () => call<Member[]>('/members'),
  /** Invite someone at a role; returns a shareable accept link (no email delivery yet). */
  inviteMember: (email: string, roleKey: InviteRole) =>
    call<{ invitationId: string; acceptUrl: string }>('/members/invite', {
      method: 'POST',
      body: JSON.stringify({ email, roleKey }),
    }),
  /** Re-send a pending invite's email; returns the (possibly refreshed) link + whether it was accepted for delivery. */
  resendInvite: (invitationId: string) =>
    call<{ invitationId: string; acceptUrl: string; emailDelivered: boolean }>('/members/resend-invite', {
      method: 'POST',
      body: JSON.stringify({ invitationId }),
    }),
  /** Withdraw a pending invite. */
  revokeInvite: (invitationId: string) =>
    call<void>('/members/revoke-invite', { method: 'POST', body: JSON.stringify({ invitationId }) }),
  /** Remove an active member (revokes their role). The owner cannot be removed. */
  removeMember: (memberId: string) =>
    call<void>('/members/remove', { method: 'POST', body: JSON.stringify({ memberId }) }),
  /** Preview an invite (unauthenticated): the team + invited email, for prefill + the accept screen. */
  previewInvite: (token: string) =>
    call<{ teamName: string; email: string; roleKey: InviteRole }>(
      `/invites/preview?token=${encodeURIComponent(token)}`,
    ),
  /** Accept an invite token; the server switches to the team, so the caller reloads after. */
  acceptInvite: (token: string) =>
    call<{ teamId: string; already?: boolean }>('/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  listApps: () => call<AppRow[]>('/apps'),
  createApp: (input: { verticalSlug: string; name: string }) =>
    call<AppRow>('/apps', { method: 'POST', body: JSON.stringify(input) }),
  deleteApp: (id: string) => call<void>(`/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  retryApp: (scopeId: string) => call<AppRow>(`/apps/${encodeURIComponent(scopeId)}/retry`, { method: 'POST' }),
  listDeployments: () => call<Deployment[]>('/deployments'),
  promoteDeployment: (slug: string, channel: 'dev' | 'staging', versionId: string) =>
    call<void>(`/deployments/${encodeURIComponent(slug)}/promote`, {
      method: 'POST',
      body: JSON.stringify({ channel, versionId }),
    }),
};

/**
 * Auth is a full-page redirect — the OIDC round-trip needs a real navigation.
 * `returnTo` is a same-origin path the callback returns to (e.g. an invite link);
 * `loginHint` prefills the email at the IdP; `screenHint` opens sign-up vs log-in.
 */
export const signIn = (
  opts: { returnTo?: string; loginHint?: string; screenHint?: 'signup' | 'login' } = {},
) => {
  const p = new URLSearchParams();
  if (opts.returnTo) p.set('returnTo', opts.returnTo);
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  if (opts.screenHint) p.set('screen_hint', opts.screenHint);
  const qs = p.toString();
  window.location.href = `/api/auth/login${qs ? `?${qs}` : ''}`;
};
export const signOut = (opts: { returnTo?: string } = {}) => {
  const rt = typeof opts?.returnTo === 'string' ? opts.returnTo : undefined;
  window.location.href = `/api/auth/logout${rt ? `?returnTo=${encodeURIComponent(rt)}` : ''}`;
};
