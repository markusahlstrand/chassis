import { useEffect, useState } from 'react';
import type { AdminLogEntry, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, EmptyState, SubIcon, SubIcons, Tabs } from '../components';
import { ActorCell } from '../patterns/ActorCell';
import { JsonDiff } from '../patterns/JsonDiff';
import type { Api } from '../lib/api';

/**
 * The runtime half of the permission checkpoint (control-plane.md §4.5).
 *
 * Roles declared in code are already emitted to `demos/*​/PERMISSIONS.md` and
 * CI-diffed. What only exists at runtime — operator-defined roles and
 * per-principal capability grants — is visible nowhere but here.
 *
 * Only ONE of the three tabs the design draws can be built today:
 *
 * - **Needs review** works, and works with no new plumbing: a role redefinition
 *   or a grant IS an admin-log row, and `before`/`after` on a `defineRole` row is
 *   literally the permission diff. This is the design's strongest idea.
 * - **Operator roles** and **Capability grants** need `listRoles` / `listGrants`.
 *   Neither exists on `HostAdmin` — there is no way to enumerate roles, grants,
 *   or principals at all. They are rendered as stated gaps rather than mocked:
 *   a permission surface that shows fabricated grants is worse than one that
 *   admits it cannot see them.
 */

/** The three writes that create permission state at runtime. */
const REVIEWABLE = ['defineRole', 'grant', 'grantToOrg'] as const;

export interface PermissionsProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
}

export function Permissions({ api, tenants }: PermissionsProps) {
  const [tab, setTab] = useState('review');
  const [rows, setRows] = useState<AdminLogEntry[]>([]);
  const [reviewed, setReviewed] = useState<Record<string, true>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      const page = await api.adminLog({ order: 'desc', limit: 50, action: [...REVIEWABLE] });
      if (live) setRows(page.entries);
    })();
    return () => {
      live = false;
    };
  }, [api]);

  const pending = rows.filter((r) => !reviewed[r.id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Permissions
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          Roles declared in code are diffed by CI. What only exists at runtime — operator-defined roles and per-record
          capability grants — is visible nowhere but here.
        </p>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'review', label: 'Needs review', count: pending.length },
          { value: 'roles', label: 'Operator roles' },
          { value: 'grants', label: 'Capability grants' },
        ]}
      />

      {tab === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {pending.length === 0 && (
            <Card>
              <EmptyState
                icon={<SubIcon d={SubIcons.cog} size={20} />}
                title="Nothing awaiting review"
                description="Runtime role and grant changes appear here as they happen."
              />
            </Card>
          )}
          {pending.map((r) => (
            <Card
              key={r.id}
              title={r.action === 'defineRole' ? 'Role redefined' : 'Capability grant'}
              description={`${tenants.get(r.tenantId)?.slug ?? r.tenantId}${r.scopeId ? ` · scope ${r.scopeId.slice(0, 8)}…` : ' (tenant-wide)'} · ${r.at.slice(0, 19).replace('T', ' ')}`}
              actions={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <ActorCell actor={r.actor} />
                  <Badge status="info">runtime</Badge>
                </span>
              }
              footer="Approval is console-side review metadata — it does not gate the change, which already applied."
            >
              <JsonDiff before={r.before} after={r.after} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                <Button variant="secondary" size="sm" onClick={() => setReviewed((p) => ({ ...p, [r.id]: true }))}>
                  Flag
                </Button>
                <Button size="sm" onClick={() => setReviewed((p) => ({ ...p, [r.id]: true }))}>
                  Approve
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Rendered as gaps, not mocks. The design draws both of these as live
          tables; the platform cannot enumerate roles or grants at all, so the
          honest thing is to name the missing read path. */}
      {tab === 'roles' && (
        <Card>
          <EmptyState
            icon={<SubIcon d={SubIcons.cog} size={20} />}
            title="Operator roles cannot be listed yet"
            description="Needs listRoles on HostAdmin — roles are writable but not enumerable. Distinguishing an operator-created role from a code-declared one also needs a new RoleDefinition.source value; today it is moduleId | 'vertical', and both mean 'declared in code'."
          />
        </Card>
      )}

      {tab === 'grants' && (
        <Card>
          <EmptyState
            icon={<SubIcon d={SubIcons.cog} size={20} />}
            title="Capability grants cannot be listed yet"
            description="Needs listGrants on HostAdmin. Every permission write is one-way today — there is no revoke and no enumeration, so this view would be the only witness to grants it cannot read."
          />
        </Card>
      )}
    </div>
  );
}
