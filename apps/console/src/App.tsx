import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Card, Toast } from './components';
import { ConsoleShell } from './ConsoleShell';
import type { ViewKey } from './ConsoleShell';
import type { BreadcrumbItem } from './components';
import { createApi } from './lib/api';
import { AdminLog } from './views/AdminLog';
import { Permissions } from './views/Permissions';
import { Scopes } from './views/Scopes';
import { TenantDetail } from './views/TenantDetail';
import { Tenants } from './views/Tenants';

/**
 * The dev actor. Read from a query param or localStorage so the console can be
 * pointed at whatever the local API printed on boot.
 *
 * This is the stub end of §6's identity seam. It is not authentication and is
 * not pretending to be: the API is what refuses an unknown actor, and real staff
 * auth (SSO/MFA, short sessions) gates EXPOSING any of this — nothing with
 * cross-tenant reach goes anywhere non-local on a stub.
 */
function useDevActor(): [string, (v: string) => void] {
  const [actor, setActor] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('actor');
    if (fromUrl) localStorage.setItem('substrat.actor', fromUrl);
    return fromUrl ?? localStorage.getItem('substrat.actor') ?? '';
  });
  return [
    actor,
    (v: string) => {
      localStorage.setItem('substrat.actor', v);
      setActor(v);
    },
  ];
}

interface Toast {
  title: string;
  detail?: string;
  status: 'success' | 'danger';
}

export function App() {
  const [actor, setActor] = useDevActor();
  const [view, setView] = useState<ViewKey>('tenants');
  const [openTenant, setOpenTenant] = useState<TenantId>();
  const [dark, setDark] = useState(false);
  const [toast, setToast] = useState<Toast>();
  const [error, setError] = useState<string>();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [entitlements, setEntitlements] = useState<Map<TenantId, string[]>>(new Map());

  const api = useMemo(() => createApi(actor), [actor]);

  useEffect(() => {
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
  }, [dark]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    if (!actor) return;
    try {
      const [ts, ss] = await Promise.all([api.listTenants(), api.listScopes()]);
      // No batch read for entitlements — one call per tenant. Fine at fleet
      // sizes the console handles today; a real N+1 to revisit if it isn't.
      const keys = await Promise.all(ts.map((t) => api.listEntitlements(t.id)));
      setTenants(ts);
      setScopes(ss);
      setEntitlements(new Map(ts.map((t, i) => [t.id, keys[i] ?? []])));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, actor]);

  useEffect(() => {
    void load();
  }, [load]);

  const tenantMap = useMemo(() => new Map(tenants.map((t) => [t.id, t])), [tenants]);
  const notify = useCallback(
    (title: string, detail?: string, status: 'success' | 'danger' = 'success') =>
      setToast({ title, detail, status }),
    [],
  );

  const detail = openTenant ? tenantMap.get(openTenant) : undefined;

  const crumbs: BreadcrumbItem[] = [
    { label: 'Fleet' },
    { label: view === 'admin-log' ? 'Admin log' : view[0]!.toUpperCase() + view.slice(1), onClick: () => setOpenTenant(undefined) },
    ...(detail ? [{ label: detail.slug, mono: true }] : []),
  ];

  if (!actor) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--surface-page)' }}>
        <Card title="Dev actor required" description="The control-plane API refuses any request without one (§4.4).">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)', maxWidth: 460, lineHeight: '19px' }}>
            Start the API with <code style={{ fontFamily: 'var(--font-mono)' }}>pnpm --filter @substrat-run/control-plane-api dev</code>{' '}
            and open this console with the actor it prints:
          </p>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            ?actor=&lt;PlatformActorId&gt;
          </code>
          <div style={{ marginTop: 12 }}>
            <input
              placeholder="Paste the PlatformActorId"
              onKeyDown={(e) => e.key === 'Enter' && setActor((e.target as HTMLInputElement).value.trim())}
              style={{
                width: 380,
                height: 32,
                padding: '0 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
              }}
            />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <ConsoleShell
      active={view}
      onNav={(v) => {
        setView(v);
        setOpenTenant(undefined);
      }}
      onToggleDark={() => setDark((d) => !d)}
      crumbs={crumbs}
      tenantCount={tenants.length}
      scopeCount={scopes.length}
    >
      {error && (
        <Card style={{ marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      {view === 'tenants' &&
        (detail ? (
          <TenantDetail
            api={api}
            tenant={detail}
            scopes={scopes.filter((s) => s.tenantId === detail.id)}
            entitlements={entitlements.get(detail.id) ?? []}
            onBack={() => setOpenTenant(undefined)}
            onChanged={() => void load()}
            onToast={notify}
          />
        ) : (
          <Tenants
            api={api}
            tenants={tenants}
            scopes={scopes}
            entitlements={entitlements}
            onOpen={setOpenTenant}
            onChanged={() => void load()}
            onToast={notify}
          />
        ))}

      {view === 'scopes' && (
        <Scopes api={api} scopes={scopes} tenants={tenantMap} entitlements={entitlements} onChanged={() => void load()} onToast={notify} />
      )}
      {view === 'admin-log' && <AdminLog api={api} tenants={tenantMap} />}
      {view === 'permissions' && <Permissions api={api} tenants={tenantMap} />}

      {toast && (
        <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 50 }}>
          <Toast status={toast.status} title={toast.title} detail={toast.detail} />
        </div>
      )}
    </ConsoleShell>
  );
}
