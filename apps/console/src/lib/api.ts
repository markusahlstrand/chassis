import type {
  AdminAction,
  AdminLogEntry,
  HostnameBinding,
  HostnameStatus,
  Scope,
  ScopeId,
  ScopeStatus,
  Tenant,
  TenantId,
  TenantRole,
  TenantStatus,
} from '@substrat-run/contracts';

/**
 * Client for the control-plane API (packages/control-plane-api).
 *
 * The types come from `@substrat-run/contracts` rather than being restated here:
 * the console renders the kernel's own vocabulary, so a field the platform
 * renames should break this build rather than render `undefined` in a table.
 */

/** Dev only. Real staff auth (SSO/MFA) gates exposing the console — §6. */
const DEV_ACTOR_HEADER = 'x-platform-actor';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function query(params: Record<string, string | string[] | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // Repeatable params (status, action) — the API reads them with c.req.queries().
    if (Array.isArray(v)) for (const one of v) q.append(k, one);
    else q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export interface AdminLogPage {
  entries: AdminLogEntry[];
  nextCursor: string | null;
}

export interface AuditLogQuery {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  actor?: string;
  action?: AdminAction[];
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/**
 * `actor` is the dev-actor id for the co-located quick path (sent as a header),
 * or null in session mode, where the staff session cookie authenticates instead.
 * `credentials: 'include'` carries that cookie (harmless in dev mode).
 */
export function createApi(actor: string | null, baseUrl = '/api') {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (actor) headers[DEV_ACTOR_HEADER] = actor;
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });
    if (!res.ok) {
      // The API answers errors as { error }; a proxy or crash may not, so fall
      // back to the status rather than throwing while handling a throw.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  const post = <T>(path: string, body?: unknown) =>
    call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    listTenants: () => call<Tenant[]>('/tenants'),
    getTenant: (id: TenantId) => call<Tenant>(`/tenants/${id}`),
    createTenant: (input: { id: TenantId; slug: string; name: string }) =>
      post<Tenant>('/tenants', input),
    setTenantStatus: (id: TenantId, status: TenantStatus) =>
      call<Tenant>(`/tenants/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),

    listEntitlements: (id: TenantId) => call<string[]>(`/tenants/${id}/entitlements`),
    grantEntitlement: (id: TenantId, key: string) =>
      call<string[]>(`/tenants/${id}/entitlements/${key}`, { method: 'PUT' }),
    revokeEntitlement: (id: TenantId, key: string) =>
      call<string[]>(`/tenants/${id}/entitlements/${key}`, { method: 'DELETE' }),

    listScopes: (filter?: { tenantId?: TenantId; status?: ScopeStatus[]; vertical?: string }) =>
      call<Scope[]>(`/scopes${query({ ...filter })}`),
    getScope: (tenantId: TenantId, scopeId: ScopeId) =>
      call<Scope>(`/tenants/${tenantId}/scopes/${scopeId}`),
    provisionScope: (input: {
      tenantId: TenantId;
      scopeId: ScopeId;
      slug?: string;
      kind?: string;
      name?: string;
      vertical?: string | null;
      storageShape?: 'A' | 'B';
      jurisdiction?: 'eu' | null;
    }) => post<Scope>('/scopes', input),

    // One method per audited transition, mirroring the API and HostAdmin. The
    // console renders only legal transitions; the graph is enforced below.
    // provisioning → active: the vertical has confirmed the scope exists (K-31).
    activateScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/activate`),
    suspendScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/suspend`),
    unsuspendScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/unsuspend`),
    archiveScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/archive`),
    unarchiveScope: (t: TenantId, s: ScopeId) => post<Scope>(`/tenants/${t}/scopes/${s}/unarchive`),

    // Read only — there is no route that writes a role, by design.
    listRoles: (filter?: { tenantId?: TenantId; source?: string }) =>
      call<TenantRole[]>(`/roles${query({ ...filter })}`),

    // The hostname map (§4.7). `resolveHostname` is absent on purpose — that is the
    // router's per-request path, not a staff action, and it is not on this surface.
    listHostnames: (filter?: { tenantId?: TenantId; scopeId?: ScopeId }) =>
      call<HostnameBinding[]>(`/hostnames${query({ ...filter })}`),
    bindHostname: (input: {
      hostname: string;
      tenantId: TenantId;
      scopeId: ScopeId;
      surface: string;
      region?: 'eu' | null;
      canonical?: boolean;
    }) => post<HostnameBinding>('/hostnames', input),
    setHostnameStatus: (hostname: string, status: HostnameStatus, note?: string) =>
      call<HostnameBinding>(`/hostnames/${encodeURIComponent(hostname)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note }),
      }),

    /**
     * Create one instance of a vertical (K-31). The control plane calls the
     * vertical, because only it can create a usable scope DO.
     *
     * Call this BEFORE `provisionScope`: the directory row should only exist once
     * the vertical is ready, so a failure leaves an invisible orphan rather than a
     * directory row promising a scope that is not there.
     */
    provisionInstance: (
      verticalSlug: string,
      input: { tenantId: TenantId; scopeId: ScopeId; owner: string; slug: string; name: string },
    ) => post<{ tenantId: TenantId; scopeId: ScopeId; owner: string }>(
      `/verticals/${encodeURIComponent(verticalSlug)}/instances`,
      input,
    ),

    adminLog: (q: AuditLogQuery = {}) => call<AdminLogPage>(`/admin-log${query({ ...q })}`),
  };
}

export type Api = ReturnType<typeof createApi>;
