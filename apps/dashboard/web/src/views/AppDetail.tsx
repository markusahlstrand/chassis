import { useState } from 'react';
import { Button, Dialog, Input, Tabs } from '@substrat-run/ui';
import type { AppRow } from '../lib/api';
import { verticalMeta, APP_TABS, DEPLOYMENTS, ENV_VARS, INTEGRATIONS, ENV_OPTS, type EnvVar } from '../lib/demo';
import { shortDate, shortId } from '../lib/format';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, CopyButton, Eyebrow, HonestyBanner, MonoTag, Pill, RowActions } from '../components/ui';
import { IntegrationCard } from './Integrations';

/**
 * App detail (screens 1i, 1j, 1k, 1l + Domains/Integrations tabs). The header and
 * the Overview tab render REAL fields from the app row; the other tabs (env vars,
 * domains, integrations, deployments, settings) run on demo data behind the
 * design's honesty framing, since the platform does not back them yet.
 */
export function AppDetail({
  app,
  tab,
  onTab,
  onDeleted,
}: {
  app: AppRow;
  tab: string;
  onTab: (t: string) => void;
  onDeleted: () => void;
}) {
  const meta = verticalMeta(app.vertical_slug);
  const statusKind = app.status === 'provisioning' ? 'info' : app.status === 'failed' ? 'danger' : 'success';
  const statusLabel = app.status === 'provisioning' ? 'Provisioning' : app.status === 'failed' ? 'Failed' : 'Active';

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.accent }} />
        <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{app.name}</span>
        <button type="button" aria-label="Rename" style={{ border: 0, background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
          <Ic name="pencil" size={14} />
        </button>
        <Pill kind={statusKind} pulse={app.status === 'provisioning'}>{statusLabel}</Pill>
        <div style={{ flex: 1 }} />
        {app.hostname && <Button onClick={() => window.open(`https://${app.hostname}`, '_blank')}>Visit ↗</Button>}
        <button type="button" aria-label="More actions" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <Ic name="dots" size={16} />
        </button>
      </div>

      <Tabs
        tabs={APP_TABS.map((t) => ({ value: t.value, label: t.label, ...(t.count !== undefined ? { count: t.count } : {}) }))}
        value={tab}
        onChange={onTab}
      />

      {tab === 'overview' && <Overview app={app} meta={meta} statusKind={statusKind} statusLabel={statusLabel} />}
      {tab === 'deployments' && <Deployments />}
      {tab === 'env' && <EnvVars />}
      {tab === 'domains' && <AppDomains />}
      {tab === 'integrations' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>{INTEGRATIONS.slice(0, 2).map((i) => <IntegrationCard key={i.name} integ={i} />)}</div>}
      {tab === 'settings' && <Settings app={app} onDeleted={onDeleted} />}
    </Page>
  );
}

function KV({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  const cell = { padding: '8px 0', borderBottom: last ? 'none' : '1px solid var(--border-subtle)' } as const;
  return (
    <>
      <span style={{ ...cell, color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ ...cell, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</span>
    </>
  );
}

function Overview({ app, meta, statusKind, statusLabel }: { app: AppRow; meta: { label: string; accent: string }; statusKind: 'success' | 'info' | 'danger'; statusLabel: string }) {
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...card, padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13 }}>
            <KV label="Vertical"><span>{meta.label}</span><MonoTag color="var(--layer-vertical)">vertical</MonoTag></KV>
            <KV label="Version"><span style={mono}>v0.0.1</span></KV>
            <KV label="Status"><Pill kind={statusKind}>{statusLabel}</Pill></KV>
            <KV label="Created"><span>{shortDate(app.created_at)}</span></KV>
            <KV label="Created by"><span style={mono}>{app.created_by}</span></KV>
            <KV label="Scope id" last>
              <span style={mono} title={app.app_scope_id}>{shortId(app.app_scope_id)}</span>
              <CopyButton text={app.app_scope_id} label="Copy scope id" />
            </KV>
          </div>
        </div>
        <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Eyebrow>Production</Eyebrow>
          {app.hostname ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 6, ...mono, color: 'var(--text-primary)' }}>{app.hostname}</span>
                <IconBox label="Copy hostname"><CopyButton text={app.hostname} size={14} /></IconBox>
                <Button variant="secondary" onClick={() => window.open(`https://${app.hostname}`, '_blank')}>Visit ↗</Button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Last deploy just now · <span style={{ fontFamily: 'var(--font-mono)' }}>v0.0.1</span></div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>A hostname is assigned once provisioning completes.</div>
          )}
        </div>
      </div>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column' }}>
        <Eyebrow style={{ paddingBottom: 12 }}>Activity</Eyebrow>
        <Timeline
          items={[
            { dot: 'success', body: <>App activated</>, time: 'just now' },
            { dot: 'info', body: <>Provisioning started</>, time: 'just now' },
            { dot: 'neutral', body: <>Created by <span style={{ fontFamily: 'var(--font-mono)' }}>{app.created_by}</span></>, time: shortDate(app.created_at) },
          ]}
        />
        <a href="#" style={{ fontSize: 12.5, marginTop: 14 }}>View full audit log</a>
      </div>
    </div>
  );
}

function Timeline({ items }: { items: Array<{ dot: 'success' | 'info' | 'neutral'; body: React.ReactNode; time: string }> }) {
  const dotColor = { success: 'var(--status-success-dot)', info: 'var(--status-info-dot)', neutral: 'var(--status-neutral-dot)' };
  return (
    <>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor[it.dot], marginTop: 5 }} />
            {i < items.length - 1 && <span style={{ width: 1, flex: 1, background: 'var(--border-default)' }} />}
          </div>
          <div style={{ paddingBottom: i < items.length - 1 ? 14 : 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{it.body}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{it.time}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function Deployments() {
  const COLS = '1fr 1.4fr 1fr 1.4fr 1.4fr 120px';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <HonestyBanner>Version history comes from the registry — promote and rollback go live when its API is surfaced. Nothing here is faked.</HonestyBanner>
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Version</span><span>Source</span><span>Status</span><span>Promoted</span><span>By</span><span />
        </div>
        {DEPLOYMENTS.map((d, i) => (
          <div key={d.version} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, borderBottom: i === DEPLOYMENTS.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{d.version}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>{d.source}</span>
            <span>{d.status === 'current' ? <Pill kind="info" style={{ background: 'var(--surface-brand-subtle)', color: 'var(--text-brand)' }}>Current</Pill> : <span style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Previous</span>}</span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{d.promoted}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{d.by}</span>
            <span>{d.status === 'previous' && <Button variant="ghost" size="sm" disabled>Rollback</Button>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EnvVars() {
  const [rows, setRows] = useState<EnvVar[]>(ENV_VARS);
  const [dirty, setDirty] = useState(0);
  const COLS = '1.4fr 2fr 150px 80px';
  const toggle = (i: number) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, revealed: !r.revealed } : r)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, position: 'relative', paddingBottom: dirty ? 60 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Secrets are masked by default — every reveal is audited.</div>
        <div style={{ flex: 1 }} />
        <Button variant="secondary" onClick={() => setDirty((d) => d + 1)}>Add from .env</Button>
      </div>
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Key</span><span>Value</span><span>Environment</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 44, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', background: r.revealed ? 'var(--surface-brand-subtle)' : 'transparent' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{r.key}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: r.revealed ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              {r.revealed ? r.value.replace('••••••••••••••••', 'sk_live_9f21…7c0a') : '••••••••••••••••'}
              {r.revealed && <span style={{ fontSize: 10, color: 'var(--status-warning-fg)', marginLeft: 8 }}>revealed — audited</span>}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{r.environment}</span>
            <span style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', color: 'var(--text-tertiary)' }}>
              <button type="button" aria-label="Reveal" onClick={() => toggle(i)} style={iconBtn}><Ic name="eye" size={14} color={r.revealed ? 'var(--brand-600)' : undefined} /></button>
              <CopyButton text={r.key} size={14} />
              <button type="button" aria-label="Delete" onClick={() => setDirty((d) => d + 1)} style={iconBtn}><Ic name="trash" size={14} /></button>
            </span>
          </div>
        ))}
        <div onClick={() => setDirty((d) => d + 1)} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 16px', color: 'var(--text-brand)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
          <Ic name="plus" size={14} />Add variable
        </div>
      </div>
      {dirty > 0 && (
        <div style={{ position: 'sticky', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}><b style={{ color: 'var(--text-primary)' }}>{dirty} unsaved change{dirty === 1 ? '' : 's'}</b> — values apply on next use.</span>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => setDirty(0)}>Discard</Button>
          <Button onClick={() => setDirty(0)}>Save changes</Button>
        </div>
      )}
    </div>
  );
}

function AppDomains() {
  const COLS = '2.4fr 1.4fr 1fr 40px';
  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span>Hostname</span><span>Status</span><span>Added</span><span />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13 }}>
        <a href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>hr.acme.com<Ic name="external" size={11} /></a>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Pill kind="success">Active</Pill><MonoTag color="var(--text-tertiary)">primary</MonoTag></span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Jul 21, 2026</span>
        <RowActions />
      </div>
    </div>
  );
}

function Settings({ app, onDeleted }: { app: AppRow; onDeleted: () => void }) {
  const meta = verticalMeta(app.vertical_slug);
  const [name, setName] = useState(app.name);
  const [confirm, setConfirm] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 }}>
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="App name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 320 }} />
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13 }}>
          <span style={{ color: 'var(--text-tertiary)', padding: '8px 0' }}>Kind</span>
          <span style={{ padding: '8px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>{meta.label} <MonoTag color="var(--layer-vertical)">vertical</MonoTag> <span style={{ color: 'var(--text-tertiary)' }}>— read-only</span></span>
        </div>
        <div><Button variant="secondary">Save</Button></div>
      </div>
      <div style={{ ...card, border: '1px solid var(--status-danger-fg)', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--status-danger-fg)' }}>Danger zone</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, flex: 1 }}>
            Deleting {app.name} deprovisions its scope and takes {app.hostname ? <span style={{ fontFamily: 'var(--font-mono)' }}>{app.hostname}</span> : 'its hostname'} offline. The audit history is retained.
          </div>
          <Button variant="danger" onClick={() => setOpen(true)}>Delete app</Button>
        </div>
      </div>
      <Dialog
        open={open}
        title={`Delete ${app.name}?`}
        danger
        confirmLabel="Delete app"
        onCancel={() => { setOpen(false); setConfirm(''); }}
        onConfirm={confirm === app.name ? onDeleted : undefined}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--status-danger-bg)', borderRadius: 6, padding: '12px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
            This deprovisions the scope the moment you confirm:
            <div>→ {app.hostname ? <span style={{ fontFamily: 'var(--font-mono)' }}>{app.hostname}</span> : 'the app hostname'} goes dark</div>
            <div>→ members lose access to this app</div>
            <div>→ App data is archived, then deleted after 30 days</div>
          </div>
          <Input label="Type the app name to confirm" placeholder={app.name} mono value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      </Dialog>
    </div>
  );
}

const iconBtn = { border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-tertiary)', display: 'inline-flex' } as const;
function IconBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-card)', color: 'var(--text-secondary)' }}>{children}</span>
  );
}
