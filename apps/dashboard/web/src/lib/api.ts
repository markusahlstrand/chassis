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

/** Who the authenticated customer is — their tenant, dashboard scope, owner principal. */
export interface Me {
  principal: PrincipalId;
  tenant: TenantId;
  dashboardScope: ScopeId;
  /** From the OIDC session — shown in the shell (footer, user pill, org label). */
  email?: string | null;
  name?: string | null;
}

export interface CatalogEntry {
  slug: string;
  name: string;
}

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
  /** `null` when there is no session (the worker answers 401). */
  me: async (): Promise<Me | null> => {
    try {
      return await call<Me>('/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  catalog: () => call<CatalogEntry[]>('/catalog'),
  listApps: () => call<AppRow[]>('/apps'),
  createApp: (input: { verticalSlug: string; name: string }) =>
    call<AppRow>('/apps', { method: 'POST', body: JSON.stringify(input) }),
  deleteApp: (id: string) => call<void>(`/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  listDeployments: () => call<Deployment[]>('/deployments'),
  promoteDeployment: (slug: string, channel: 'dev' | 'staging', versionId: string) =>
    call<void>(`/deployments/${encodeURIComponent(slug)}/promote`, {
      method: 'POST',
      body: JSON.stringify({ channel, versionId }),
    }),
};

/** Auth is a full-page redirect — the OIDC round-trip needs a real navigation. */
export const signIn = () => {
  window.location.href = '/api/auth/login';
};
export const signOut = () => {
  window.location.href = '/api/auth/logout';
};
