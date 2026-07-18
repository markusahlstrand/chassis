import { useMemo, useState } from 'react';
import type { Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, KeyValue, Table, Tabs, Tag } from '../components';
import type { TableColumn } from '../components';
import {
  availableActions,
  effectiveStatus,
  fleetCounts,
  isSuspended,
  scopeHandle,
  statusLabel,
  statusTone,
} from '../lib/fleet';
import { portalUrl } from '../lib/portal';
import type { Api } from '../lib/api';

export interface ScopesProps {
  api: Api;
  scopes: Scope[];
  tenants: Map<TenantId, Tenant>;
  entitlements: Map<TenantId, string[]>;
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

function Stat({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-xs)',
        padding: 14,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', margin: '4px 0 2px' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{meta}</div>
    </div>
  );
}

export function Scopes({ api, scopes, tenants, entitlements, onChanged, onToast }: ScopesProps) {
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState<Scope>();

  const counts = useMemo(() => fleetCounts(scopes, tenants), [scopes, tenants]);
  const tenantList = useMemo(() => [...tenants.values()], [tenants]);
  const skuTotal = useMemo(
    () => [...entitlements.values()].reduce((n, keys) => n + keys.length, 0),
    [entitlements],
  );

  const rows = useMemo(
    () =>
      scopes.filter((s) => {
        const eff = effectiveStatus(s, tenants.get(s.tenantId));
        if (tab === 'suspended') return isSuspended(eff);
        if (tab === 'archived') return eff === 'archived' || eff === 'archiving';
        return true;
      }),
    [scopes, tenants, tab],
  );

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    try {
      await fn();
      onChanged();
      setSelected(undefined);
      onToast(title, detail);
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    }
  }

  const columns: TableColumn<Scope>[] = [
    { header: 'Scope', render: (s) => s.name },
    { header: 'Slug', render: (s) => scopeHandle(s, tenants), mono: true, muted: true },
    { header: 'Kind', render: (s) => <Tag mono>{s.kind}</Tag> },
    { header: 'Shape', render: (s) => s.storageShape, mono: true, align: 'center', width: 70 },
    {
      header: 'Jurisdiction',
      render: (s) => (s.jurisdiction ? <Tag mono>{s.jurisdiction}</Tag> : <span style={{ color: 'var(--text-placeholder)' }}>—</span>),
    },
    { header: 'Schema', render: (s) => s.schemaVersion, mono: true, muted: true, width: 80 },
    {
      header: 'Status',
      align: 'right',
      render: (s) => {
        const eff = effectiveStatus(s, tenants.get(s.tenantId));
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
            {/* A cascade-suspended scope's own row still says `active`. The note
                is what keeps the badge from looking like a per-scope suspend the
                operator could undo here. */}
            {eff === 'suspended-via-tenant' && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>via tenant</span>
            )}
            {/* A scope whose migration failed is `active` in the lifecycle and
                serving nothing. Shown BESIDE the status rather than replacing it:
                the two are orthogonal, and collapsing them would hide which of the
                two an operator has to act on. */}
            {s.migrationFailure && <Badge status="danger">Migration failed</Badge>}
            <Badge status={statusTone(eff)}>{statusLabel(eff)}</Badge>
          </span>
        );
      },
    },
  ];

  const eff = selected ? effectiveStatus(selected, tenants.get(selected.tenantId)) : undefined;
  const actions = eff ? availableActions(eff) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Scopes
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
          Fleet-wide directory — every scope is its own database and consistency domain.
        </p>
      </div>

      {/* Only what the directory and entitlement store can actually answer.
          Event counts and queue telemetry are not computable and are not shown. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Stat label="Active scopes" value={counts.active} meta={`of ${counts.scopes} in the directory`} />
        <Stat
          label="Tenants"
          value={tenantList.length}
          meta={`${tenantList.filter((t) => t.status === 'active').length} active · ${tenantList.filter((t) => t.status !== 'active').length} not`}
        />
        <Stat
          label="Suspended scopes"
          value={counts.suspended}
          meta={counts.viaCascade > 0 ? `${counts.viaCascade} via tenant cascade` : 'none via cascade'}
        />
        <Stat label="Entitlements held" value={skuTotal} meta={`across ${entitlements.size} tenants`} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'all', label: 'All', count: counts.scopes },
          { value: 'suspended', label: 'Suspended', count: counts.suspended },
          { value: 'archived', label: 'Archived', count: counts.archived },
        ]}
      />

      <Card padding={0}>
        <Table columns={columns} rows={rows} onRowClick={setSelected} emptyText="No scopes match this filter." />
      </Card>

      {selected && eff && (
        <Card
          title={selected.name}
          description={`Scope detail — ${scopeHandle(selected, tenants)}`}
          actions={
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {portalUrl(selected) && (
                <a
                  href={portalUrl(selected)!}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--brand-700)', textDecoration: 'none', marginRight: 4 }}
                >
                  Open portal ↗
                </a>
              )}
              {actions.includes('unsuspend') && (
                <Button onClick={() => run(() => api.unsuspendScope(selected.tenantId, selected.id), 'Scope unsuspended', selected.slug)}>
                  Unsuspend
                </Button>
              )}
              {actions.includes('unarchive') && (
                <Button onClick={() => run(() => api.unarchiveScope(selected.tenantId, selected.id), 'Scope restored', `${selected.slug} · migrations replay on next access`)}>
                  Restore scope
                </Button>
              )}
              {actions.includes('suspend') && (
                <Button variant="danger" onClick={() => run(() => api.suspendScope(selected.tenantId, selected.id), 'Scope suspended', `${selected.slug} fails closed`)}>
                  Suspend
                </Button>
              )}
              {actions.includes('archive') && (
                <Button variant="secondary" onClick={() => run(() => api.archiveScope(selected.tenantId, selected.id), 'Scope archived', selected.slug)}>
                  Archive
                </Button>
              )}
              <Button variant="secondary" onClick={() => setSelected(undefined)}>
                Close
              </Button>
            </span>
          }
        >
          <KeyValue
            columns={4}
            items={[
              { label: 'Scope ID', value: selected.id, mono: true },
              { label: 'Tenant', value: tenants.get(selected.tenantId)?.name ?? '—' },
              { label: 'Vertical', value: selected.vertical ?? '—', mono: true },
              { label: 'Kind', value: selected.kind, mono: true },
              { label: 'Storage shape', value: `Shape ${selected.storageShape}` },
              // Fixed at provisioning (K-7) — displayed, never editable.
              { label: 'Jurisdiction', value: selected.jurisdiction ? 'EU — fixed at provisioning' : 'Unrestricted' },
              { label: 'Schema', value: selected.schemaVersion, mono: true },
              ...(selected.migrationFailure
                ? [
                    {
                      label: 'Migration failed',
                      value: selected.migrationFailure.version,
                      mono: true,
                    },
                    {
                      label: 'Attempts',
                      value: String(selected.migrationFailure.attempts),
                      mono: true,
                    },
                  ]
                : []),
              { label: 'Created', value: selected.createdAt.slice(0, 10), mono: true },
            ]}
          />
          {selected.migrationFailure && (
            <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              This scope failed closed and is serving nothing — the schema count above is
              what landed before <code>{selected.migrationFailure.version}</code> rolled back.
              Recovery is per-scope PITR plus a patched forward migration (kernel-design §5.3).
              Last attempt {selected.migrationFailure.lastAttemptAt.slice(0, 19).replace('T', ' ')}:{' '}
              {selected.migrationFailure.error}
            </p>
          )}
          {eff === 'suspended-via-tenant' && (
            <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Suspended by a tenant-wide cascade — unsuspend the tenant to release it; per-scope unsuspend is not offered.
            </p>
          )}
          {(eff === 'provisioning' || eff === 'archiving') && (
            <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              Transient state — actions available when it settles.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
