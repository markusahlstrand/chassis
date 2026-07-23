import { useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import type { CatalogEntry } from '../lib/api';
import { MARKETPLACE, REPOS, ENV_OPTS } from '../lib/demo';
import { Ic } from '../lib/icons';
import { slugify } from '../lib/format';
import { Page } from '../components/layout';
import { card, CopyButton, MonoTag } from '../components/ui';

interface Source {
  /** Display name of the picked repo/marketplace project. */
  title: string;
  engineLine: string;
  accent: string;
  origin: string;
  defaultName: string;
  /** The catalog slug the app is actually created under. */
  verticalSlug: string;
}

/**
 * Create App (screens 1g, 1h). Step 1 picks a source (Git import / marketplace /
 * CLI — the repos and projects are demo). Step 2 configures + creates: the name
 * and URL are real inputs, and Create calls the worker's `POST /api/apps` with a
 * real catalog slug. The catalog gates which verticals are instantiable; today
 * that is Documents (`protocol`), so every source maps onto it.
 */
export function CreateApp({
  catalog,
  onCancel,
  onCreate,
}: {
  catalog: CatalogEntry[];
  onCancel: () => void;
  onCreate: (input: { verticalSlug: string; name: string }) => Promise<void>;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const fallbackSlug = catalog[0]?.slug ?? 'protocol';
  // A source's desired slug is honoured only if the live catalog actually offers
  // it (entitlements gate what's instantiable); otherwise it falls back to the
  // first available vertical. So the Callout tile provisions a real Callout scope,
  // while a source with no real vertical still creates *something* rather than 400.
  const resolveSlug = (wanted: string) => (catalog.some((c) => c.slug === wanted) ? wanted : fallbackSlug);

  if (!source) {
    return (
      <ChooseSource
        onCancel={onCancel}
        onPick={(s) => setSource({ ...s, verticalSlug: resolveSlug(s.wantedSlug) })}
      />
    );
  }
  return <Configure source={source} onBack={() => setSource(null)} onCancel={onCancel} onCreate={onCreate} disabled={catalog.length === 0} />;
}

function Stepper({ step }: { step: 1 | 2 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: step === 1 ? 500 : 400, color: step === 1 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: step === 1 ? 'var(--brand-600)' : 'var(--surface-active)', color: step === 1 ? '#fff' : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
          {step === 1 ? '1' : <Ic name="check" size={12} color="var(--status-success-fg)" />}
        </span>
        Source
      </span>
      <span style={{ width: 48, height: 1, background: 'var(--border-strong)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: step === 2 ? 500 : 400, color: step === 2 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: step === 2 ? 'var(--brand-600)' : 'transparent', border: step === 2 ? 'none' : '1px solid var(--border-strong)', color: step === 2 ? '#fff' : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, boxSizing: 'border-box' }}>2</span>
        Configure
      </span>
    </div>
  );
}

function Header({ onCancel }: { onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Create an app</div>
      <div style={{ flex: 1 }} />
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function SourceRow({ title, subtitle, accent, action, onAction, height = 52 }: { title: React.ReactNode; subtitle: string; accent: string; action: string; onAction: () => void; height?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent }} />
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{subtitle}</span>
      </span>
      <Button variant="secondary" size="sm" onClick={onAction}>{action}</Button>
    </div>
  );
}

type PickedSource = Omit<Source, 'verticalSlug'> & { wantedSlug: string };

function ChooseSource({ onCancel, onPick }: { onCancel: () => void; onPick: (s: PickedSource) => void }) {
  return (
    <Page maxWidth={960}>
      <Header onCancel={onCancel} />
      <Stepper step={1} />
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* Git import */}
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Import a Git repository</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)', fontSize: 13, cursor: 'pointer' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>acme-inc</span>
                <Ic name="chevronDown" size={12} color="var(--text-tertiary)" />
              </span>
              <Input placeholder="Search repositories…" style={{ flex: 1 }} />
            </div>
          </div>
          {REPOS.map((r) => (
            <SourceRow
              key={r.name}
              title={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.name}</span>}
              subtitle={r.meta}
              accent={r.accent}
              action="Import"
              onAction={() => onPick({ title: r.name, engineLine: `${r.meta.split(' · ')[0]} · imported from GitHub`, accent: r.accent, origin: 'github', defaultName: prettyName(r.name), wantedSlug: r.slug })}
            />
          ))}
          <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
            Missing a repository? <a href="#">Adjust the GitHub app’s access</a>
          </div>
        </div>

        {/* Marketplace + CLI */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Start from the marketplace</span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>ready-made projects</span>
            </div>
            {MARKETPLACE.map((m) => (
              <SourceRow
                key={m.name}
                title={m.name}
                subtitle={m.meta}
                accent={m.accent}
                action="Deploy"
                height={56}
                onAction={() => onPick({ title: m.name, engineLine: `${m.name.split(' — ')[1] ?? 'marketplace'} · deployed as your instance`, accent: m.accent, origin: 'marketplace', defaultName: m.name.split(' — ')[0]!, wantedSlug: m.slug })}
              />
            ))}
            <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>Browse all → · Built something reusable? <a href="#">Publish your project</a></div>
          </div>
          <div style={{ background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>Or deploy from your terminal</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 6, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>$</span>
              <span style={{ flex: 1 }}>npx substrat deploy</span>
              <CopyButton text="npx substrat deploy" />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Links this workspace on first run — the app appears here as it provisions.</div>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Marketplace projects deploy as your own instance — your data, your domain. Engine entitlements come from <a href="#">your plan</a>.
      </div>
    </Page>
  );
}

function Configure({ source, onBack, onCancel, onCreate, disabled }: { source: Source; onBack: () => void; onCancel: () => void; onCreate: (i: { verticalSlug: string; name: string }) => Promise<void>; disabled: boolean }) {
  const [name, setName] = useState(source.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const host = slugify(name);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({ verticalSlug: source.verticalSlug, name: name.trim() || source.defaultName });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Page maxWidth={720}>
      <Header onCancel={onCancel} />
      <Stepper step={2} />
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: source.accent }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {source.title} {source.origin === 'github' && <MonoTag>main</MonoTag>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{source.engineLine}</div>
          </div>
          <div style={{ flex: 1 }} />
          <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ fontSize: 12.5 }}>Change</a>
        </div>

        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Prefilled from the source — you can rename later." />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>URL</div>
          <div style={{ display: 'flex', alignItems: 'center', height: 32, border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
            <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-primary)', background: 'var(--surface-card)' }}>{host}</span>
            <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-tertiary)', background: 'var(--surface-inset)', borderLeft: '1px solid var(--border-subtle)', flex: 1 }}>.global.substrat.run</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Live as soon as provisioning completes. Custom domains attach later.</div>
        </div>

        <Select label="Environment" options={ENV_OPTS} value="Production" style={{ width: 220 }} />

        {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <Button onClick={submit} disabled={busy || disabled}>{busy ? 'Creating…' : 'Create app'}</Button>
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Appears in your grid immediately — provisions in the background.</div>
        </div>
      </div>
    </Page>
  );
}

function prettyName(repo: string): string {
  const tail = repo.split('/').pop() ?? repo;
  return tail
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
