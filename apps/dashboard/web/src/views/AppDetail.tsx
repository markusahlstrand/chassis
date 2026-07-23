import { useEffect, useState } from 'react';
import { Button, Dialog, Input, Tabs } from '@substrat-run/ui';
import { api, type AppRow, type AppEvent, type Deployment } from '../lib/api';
import { verticalMeta, APP_TABS, ENV_VARS, INTEGRATIONS, ENV_OPTS, type EnvVar } from '../lib/demo';
import { DEV_MOCK, MOCK_DEPLOYMENTS } from '../lib/mock';
import { relativeTime, shortDate, shortId } from '../lib/format';
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
      {tab === 'deployments' && <Deployments app={app} />}
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
  // The app's REAL audit trail (created / active / failed+reason / deleted). Dev-preview
  // shows a representative sample; a live deploy reads it from the worker.
  const [events, setEvents] = useState<AppEvent[] | null>(null);
  useEffect(() => {
    if (DEV_MOCK) {
      setEvents(mockEventsFor(app));
      return;
    }
    let live = true;
    api
      .appEvents(app.app_scope_id)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);
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
        {events === null ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading activity…</div>
        ) : events.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No activity recorded yet.</div>
        ) : (
          <Timeline items={events.map(toTimelineItem)} />
        )}
      </div>
    </div>
  );
}

type TimelineDot = 'success' | 'info' | 'neutral' | 'danger';

/** An app-event → a timeline row. `failed` carries the reason (the whole point of the audit trail). */
function toTimelineItem(e: AppEvent): { dot: TimelineDot; body: React.ReactNode; time: string } {
  const time = relativeTime(e.created_at);
  switch (e.kind) {
    case 'active':
      return { dot: 'success', body: <>App active{e.detail ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{e.detail}</span></> : null}</>, time };
    case 'failed':
      return { dot: 'danger', body: <>Provisioning failed{e.detail ? <> — {e.detail}</> : null}</>, time };
    case 'deleted':
      return { dot: 'neutral', body: <>Deleted</>, time };
    case 'created':
    default:
      return { dot: 'info', body: <>Provisioning started{e.detail ? <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{e.detail}</span></> : null}</>, time };
  }
}

/** Dev-preview sample so the panel isn't empty without a backend. */
function mockEventsFor(app: AppRow): AppEvent[] {
  const base = { app_scope_id: app.app_scope_id, actor: app.created_by };
  const events: AppEvent[] = [{ ...base, id: 'e1', kind: 'created', detail: app.vertical_slug, created_at: app.created_at }];
  if (app.status === 'active') events.unshift({ ...base, id: 'e2', kind: 'active', detail: app.hostname, created_at: app.created_at });
  if (app.status === 'failed') events.unshift({ ...base, id: 'e2', kind: 'failed', detail: 'no deployment is bound for vertical', created_at: app.created_at });
  return events;
}

function Timeline({ items }: { items: Array<{ dot: TimelineDot; body: React.ReactNode; time: string }> }) {
  const dotColor = { success: 'var(--status-success-dot)', info: 'var(--status-info-dot)', neutral: 'var(--status-neutral-dot)', danger: 'var(--status-danger-dot)' };
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

function Deployments({ app }: { app: AppRow }) {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (DEV_MOCK) {
      setDep(MOCK_DEPLOYMENTS[0] ?? null);
      return;
    }
    let live = true;
    api
      .appDeployments(app.app_scope_id)
      .then((d) => live && setDep(d))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load deployments — {err}</div>;
  if (!dep) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading deployments…</div>;

  const channelsOf = (versionId: string) => dep.channels.filter((c) => c.versionId === versionId).map((c) => c.channel);
  const prod = dep.channels.find((c) => c.channel === 'prod');
  const running = prod ? dep.versions.find((v) => v.id === prod.versionId) : undefined;
  const COLS = '1fr 1.2fr 1.6fr 1.4fr';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ ...card, padding: 20, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Eyebrow>Running</Eyebrow>
        {running ? (
          <>
            <MonoTag>{running.version}</MonoTag>
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>on the <b>prod</b> channel of <MonoTag>{dep.displaySlug}</MonoTag></span>
          </>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No <b>prod</b> version promoted yet — a pushed version must be admitted and promoted to serve.</span>
        )}
      </div>
      <HonestyBanner>Read live from the registry. Versions for this vertical are managed by the Substrat team; promotion to prod is a staff action.</HonestyBanner>
      {dep.versions.length === 0 ? (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>No versions pushed to the registry yet.</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
            <span>Version</span><span>Admission</span><span>Channels</span><span>Pushed</span>
          </div>
          {dep.versions.map((v, i) => {
            const chans = channelsOf(v.id);
            return (
              <div key={v.id} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', minHeight: 40, padding: '8px 16px', fontSize: 13, borderBottom: i === dep.versions.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{v.version}</span>
                <span><Pill kind={v.admission === 'admitted' ? 'success' : v.admission === 'rejected' ? 'danger' : 'warning'}>{v.admission}</Pill></span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {chans.length === 0 ? <span style={{ color: 'var(--text-tertiary)' }}>—</span> : chans.map((ch) => <Pill key={ch} kind={ch === 'prod' ? 'success' : ch === 'staging' ? 'info' : 'neutral'}>{ch}</Pill>)}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{v.createdAt ? relativeTime(v.createdAt) : '—'}</span>
              </div>
            );
          })}
        </div>
      )}
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
        confirmDisabled={confirm !== app.name}
        onConfirm={onDeleted}
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
