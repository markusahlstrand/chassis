import { Fragment, useState } from 'react';

/**
 * The before/after diff — the core of the admin log (control-plane.md §4.5).
 *
 * `before`/`after` are `unknown` on the wire and genuinely arbitrary: a
 * redefined role's permission array, a status flip, a whole tenant record. That
 * diff IS the permission checkpoint the platform has been promising — "captures
 * before/after when a role is redefined" is a contract test, and this is where a
 * human finally reads it.
 */

type Flat = Record<string, string>;

/** Flatten to dot-joined paths (arrays by index) so two shapes can be compared per-leaf. */
export function flattenJson(value: unknown, prefix = '', out: Flat = {}): Flat {
  if (value === null || typeof value !== 'object') {
    out[prefix || '(value)'] = JSON.stringify(value) ?? 'undefined';
    return out;
  }
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((x, i) => [i, x])
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) out[prefix || '(value)'] = Array.isArray(value) ? '[]' : '{}';
  for (const [k, v] of entries) flattenJson(v, prefix ? `${prefix}.${k}` : String(k), out);
  return out;
}

type RowKind = 'added' | 'removed' | 'same' | 'changed';
type Tone = 'del' | 'add' | null;

function Cell({ text, tone }: { text: string | undefined; tone: Tone }) {
  if (text === undefined) return null;
  // Long values degrade to a truncation with the full text on hover, rather than
  // blowing out the grid — a payload can be arbitrarily deep.
  const body = text.length > 96 ? <span title={text}>{text.slice(0, 96)}…</span> : text;
  return (
    <span
      style={{
        display: 'inline-block',
        maxWidth: '100%',
        padding: '1px 6px',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        background:
          tone === 'del' ? 'var(--status-danger-bg)' : tone === 'add' ? 'var(--status-success-bg)' : 'transparent',
        color:
          tone === 'del' ? 'var(--status-danger-fg)' : tone === 'add' ? 'var(--status-success-fg)' : 'var(--text-secondary)',
        textDecoration: tone === 'del' ? 'line-through' : 'none',
      }}
    >
      {body}
    </span>
  );
}

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  color: 'var(--text-link)',
  padding: 0,
};

export function JsonDiff({ before, after }: { before: unknown; after: unknown }) {
  const [showRaw, setShowRaw] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);

  const a = flattenJson(before ?? {});
  const b = flattenJson(after ?? {});
  const paths = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const rows = paths.map((p) => {
    const inA = p in a;
    const inB = p in b;
    const kind: RowKind = !inA ? 'added' : !inB ? 'removed' : a[p] === b[p] ? 'same' : 'changed';
    return { p, old: a[p], nw: b[p], kind };
  });
  const changed = rows.filter((r) => r.kind !== 'same');
  const same = rows.filter((r) => r.kind === 'same');

  return (
    <div
      style={{
        background: 'var(--surface-inset)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: changed.length ? 10 : 0 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}
        >
          {/* `before: null` is not an empty diff — it is a create. The adapters
              pass null where there is no cheaply readable prior state. */}
          {before === null || before === undefined
            ? 'Created — no prior state'
            : `${changed.length} change${changed.length === 1 ? '' : 's'}`}
        </span>
        <span style={{ flex: 1 }} />
        {same.length > 0 && (
          <button type="button" onClick={() => setShowUnchanged(!showUnchanged)} style={linkButton}>
            {showUnchanged ? 'Hide' : 'Show'} {same.length} unchanged
          </button>
        )}
        <button type="button" onClick={() => setShowRaw(!showRaw)} style={linkButton}>
          {showRaw ? 'Diff view' : 'Raw JSON'}
        </button>
      </div>

      {showRaw ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {([['before', before], ['after', after]] as const).map(([label, v]) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
                {label}
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  background: 'var(--surface-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  fontSize: 12,
                  lineHeight: '18px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  overflow: 'auto',
                  maxHeight: 220,
                }}
              >
                {v === null || v === undefined ? 'null' : JSON.stringify(v, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(120px,auto) 1fr 1fr',
            gap: '4px 12px',
            alignItems: 'baseline',
          }}
        >
          {(showUnchanged ? rows : changed).map((r) => (
            <Fragment key={r.p}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>{r.p}</span>
              <span>{r.kind !== 'added' && <Cell text={r.old} tone={r.kind === 'same' ? null : 'del'} />}</span>
              <span>{r.kind !== 'removed' && <Cell text={r.nw} tone={r.kind === 'same' ? null : 'add'} />}</span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
