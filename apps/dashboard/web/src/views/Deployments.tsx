import { useMemo, useState } from 'react';
import { Button } from '@substrat-run/ui';
import type { Deployment, DeploymentVersion } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Page } from '../components/layout';
import { GridTable, Row } from '../components/layout';
import { Pill, PageTitle, MonoTag, type PillKind } from '../components/ui';

/**
 * Deployments (builder-plane.md Phase 4) — the builder-facing mirror of the staff
 * console's Verticals, narrowed to the verticals THIS tenant pushed. Per vertical: its
 * versions + admission state, and which channel points where. A builder self-serves
 * `dev`/`staging`; `prod` is read-only here — production promotion + admission stay a
 * staff decision (model B), shown but not actionable.
 */

const ADMISSION_PILL: Record<string, PillKind> = {
  admitted: 'success',
  pending: 'warning',
  rejected: 'danger',
};

/** Which channels point at a given version id. */
function channelsFor(d: Deployment, versionId: string): string[] {
  return d.channels.filter((c) => c.versionId === versionId).map((c) => c.channel);
}

const CHANNEL_PILL: Record<string, PillKind> = { prod: 'success', staging: 'info', dev: 'neutral' };

function VersionRow({
  d,
  v,
  last,
  busy,
  onPromote,
}: {
  d: Deployment;
  v: DeploymentVersion;
  last: boolean;
  busy: boolean;
  onPromote: (channel: 'dev' | 'staging') => void;
}) {
  const here = channelsFor(d, v.id);
  const admitted = v.admission === 'admitted';
  return (
    <Row columns="1.2fr 1fr 1.4fr 1.6fr" last={last}>
      <span style={{ fontWeight: 500 }}>{v.version}</span>
      <span>
        <Pill kind={ADMISSION_PILL[v.admission] ?? 'neutral'}>{v.admission}</Pill>
      </span>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {here.length === 0 ? (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ) : (
          here.map((ch) => (
            <Pill key={ch} kind={CHANNEL_PILL[ch] ?? 'neutral'}>
              {ch}
            </Pill>
          ))
        )}
      </span>
      <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {/* A builder self-serves non-prod. Only an ADMITTED version can be promoted. */}
        {(['dev', 'staging'] as const).map((ch) =>
          here.includes(ch) ? null : (
            <Button
              key={ch}
              variant="ghost"
              size="sm"
              disabled={!admitted || busy}
              onClick={() => onPromote(ch)}
            >
              → {ch}
            </Button>
          ),
        )}
      </span>
    </Row>
  );
}

function DeploymentCard({
  d,
  busy,
  onPromote,
}: {
  d: Deployment;
  busy: boolean;
  onPromote: (versionId: string, channel: 'dev' | 'staging') => void;
}) {
  const prod = d.channels.find((c) => c.channel === 'prod');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{d.name}</h3>
        <MonoTag>{d.displaySlug}</MonoTag>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {prod ? (
            <>
              prod at <MonoTag>{d.versions.find((v) => v.id === prod.versionId)?.version ?? prod.versionId}</MonoTag>
            </>
          ) : (
            'not in production'
          )}
        </span>
      </div>
      {d.versions.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-tertiary)', fontSize: 13 }}>
          No versions yet — <code>substrat push</code> one.
        </div>
      ) : (
        <GridTable columns="1.2fr 1fr 1.4fr 1.6fr" header={['Version', 'Admission', 'Channels', '~Promote']}>
          {d.versions.map((v, i) => (
            <VersionRow
              key={v.id}
              d={d}
              v={v}
              last={i === d.versions.length - 1}
              busy={busy}
              onPromote={(ch) => onPromote(v.id, ch)}
            />
          ))}
        </GridTable>
      )}
    </div>
  );
}

export function Deployments({
  deployments,
  onPromote,
  busy,
}: {
  deployments: Deployment[];
  onPromote: (slug: string, versionId: string, channel: 'dev' | 'staging') => void;
  busy: boolean;
}) {
  // Sort newest-active first by the most recent version id.
  const sorted = useMemo(
    () => [...deployments].sort((a, b) => (a.versions[0]?.id ?? '') < (b.versions[0]?.id ?? '') ? 1 : -1),
    [deployments],
  );

  return (
    <Page>
      <PageTitle
        title="Deployments"
        subtitle="The verticals you’ve pushed. Promote dev and staging yourself; production is reviewed and promoted by the Substrat team."
      />
      {sorted.length === 0 ? (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <p style={{ marginBottom: 8 }}>No deployments yet.</p>
          <p style={{ fontSize: 13 }}>
            Push a vertical with the CLI: <code>substrat push ./my-vertical --slug my-app --version 0.1.0</code>
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 28 }}>
          {sorted.map((d) => (
            <DeploymentCard key={d.slug} d={d} busy={busy} onPromote={(vid, ch) => onPromote(d.slug, vid, ch)} />
          ))}
        </div>
      )}
    </Page>
  );
}
