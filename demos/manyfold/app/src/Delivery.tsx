import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Card, Mono } from './ui';

// The delivery surface preview: what the public read API serves for a published entry —
// the frozen revision, references resolved (a draft/archived target shows as an explicit
// unresolved marker), ETag = the content hash.

export function DeliveryPreview({ typeKey, slug }: { typeKey: string; slug: string }) {
  const [payload, setPayload] = useState<{ hash: string; publishedAt: string; body: Record<string, unknown> } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.deliver(typeKey, slug).then(setPayload).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, [typeKey, slug]);

  if (err) return <Card style={{ color: 'var(--st-danger-fg)', background: 'var(--st-danger-bg)', borderColor: 'transparent' }}>{err}</Card>;
  if (!payload) return <Card><Mono>resolving delivery…</Mono></Card>;

  const unresolved = countUnresolved(payload.body);
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, color: 'var(--st-published-fg)', background: 'var(--st-published-bg)', padding: '2px 9px', borderRadius: 'var(--r-pill)', fontSize: 11.5 }}>200 · FROZEN ❄</span>
        <Mono>GET /sites/·/{typeKey}/{slug}</Mono>
        <div style={{ flex: 1 }} />
        <Mono title={payload.hash}>ETag "{payload.hash.slice(0, 8)}…" · cache-control: public, immutable</Mono>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        <div style={{ padding: 14, borderRight: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 8 }}>Resolved</div>
          {Object.entries(payload.body).map(([k, v]) => (
            <div key={k} style={{ padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <Mono style={{ fontSize: 11 }}>{k}</Mono>
              <div>{renderResolved(v)}</div>
            </div>
          ))}
          {unresolved > 0 && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--st-danger-fg)' }}>
              {unresolved} reference{unresolved === 1 ? '' : 's'} unresolved — target not published; omitted from delivery.
            </div>
          )}
        </div>
        <pre style={{ margin: 0, padding: 14, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 11.5, overflow: 'auto', maxHeight: 360 }}>
          {highlight(JSON.stringify(payload.body, null, 2))}
        </pre>
      </div>
    </Card>
  );
}

function isUnresolved(v: unknown): v is { $unresolved: true; reason: string } {
  return !!v && typeof v === 'object' && (v as { $unresolved?: boolean }).$unresolved === true;
}
function isResolvedRef(v: unknown): v is { $ref: string; title: string } {
  return !!v && typeof v === 'object' && typeof (v as { $ref?: string }).$ref === 'string';
}

function renderResolved(v: unknown): React.ReactNode {
  if (Array.isArray(v)) return <span>{v.map((x, i) => <span key={i} style={{ marginRight: 8 }}>{renderResolved(x)}</span>)}</span>;
  if (isUnresolved(v)) return <span style={{ color: 'var(--st-danger-fg)', fontStyle: 'italic' }}>⛓ unresolved ({v.reason})</span>;
  if (isResolvedRef(v)) return <span style={{ color: 'var(--accent)' }}>→ {v.title}</span>;
  if (v === null || v === undefined || v === '') return <span style={{ color: 'var(--faint)' }}>—</span>;
  return <span>{String(v)}</span>;
}

function countUnresolved(body: Record<string, unknown>): number {
  let n = 0;
  for (const v of Object.values(body)) {
    if (isUnresolved(v)) n++;
    else if (Array.isArray(v)) n += v.filter(isUnresolved).length;
  }
  return n;
}

function highlight(json: string): React.ReactNode {
  return json.split('\n').map((line, i) => (
    <div key={i} style={line.includes('$unresolved') ? { color: '#f08c79' } : undefined}>{line}</div>
  ));
}
