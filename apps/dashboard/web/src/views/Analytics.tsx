import { Badge, Select } from '@substrat-run/ui';
import { KPIS, BARS, ANALYTICS_ROWS, APP_FILTER, RANGE_OPTS } from '../lib/demo';
import { Page } from '../components/layout';
import { card } from '../components/ui';

/** Analytics — marked "Preview" in-product (screen 1u). Estimated demo figures. */
export function Analytics() {
  const max = Math.max(...BARS.map((b) => b.hr + b.ops + b.legal));
  const scale = 170 / max;
  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Analytics</span>
            <Badge status="info" dot={false}>Preview</Badge>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Estimated until the metrics pipeline is wired — read-only, clearly labeled.</div>
        </div>
        <div style={{ flex: 1 }} />
        <Select options={APP_FILTER} value="All apps" style={{ width: 160 }} />
        <Select options={RANGE_OPTS} value="Last 7 days" style={{ width: 150 }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        {KPIS.map((k) => (
          <div key={k.label} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{k.label}</span>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{k.value}</span>
            <span style={{ fontSize: 12, color: k.up ? 'var(--status-success-fg)' : 'var(--status-danger-fg)' }}>{k.delta}</span>
          </div>
        ))}
      </div>

      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Requests by app</span>
          <div style={{ flex: 1 }} />
          {[['Acme HR', 'var(--layer-vertical)'], ['Acme Field Ops', 'var(--layer-engine)'], ['Acme Legal', 'var(--layer-kernel)']].map(([label, color]) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />{label}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 180, borderBottom: '1px solid var(--border-default)', padding: '0 4px' }}>
          {BARS.map((b, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', gap: 1 }}>
              <div style={{ height: b.hr * scale, background: 'var(--layer-vertical)', borderRadius: 1, opacity: 0.85 }} />
              <div style={{ height: b.ops * scale, background: 'var(--layer-engine)', borderRadius: 1, opacity: 0.85 }} />
              <div style={{ height: b.legal * scale, background: 'var(--layer-kernel)', borderRadius: '2px 2px 1px 1px', opacity: 0.85 }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {['Jul 9', 'Jul 12', 'Jul 15', 'Jul 18', 'Jul 21'].map((d) => <span key={d}>{d}</span>)}
        </div>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>App</span><span style={{ textAlign: 'right' }}>Requests</span><span style={{ textAlign: 'right' }}>Users</span><span style={{ textAlign: 'right' }}>Error rate</span><span style={{ textAlign: 'right' }}>Trend</span>
        </div>
        {ANALYTICS_ROWS.map((r, i) => (
          <div key={r.app} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, borderBottom: i === ANALYTICS_ROWS.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, color: 'var(--text-primary)' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: r.accent }} />{r.app}</span>
            <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{r.requests}</span>
            <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{r.users}</span>
            <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{r.errorRate}</span>
            <span style={{ textAlign: 'right', fontSize: 12, color: r.up ? 'var(--status-success-fg)' : 'var(--status-danger-fg)' }}>{r.up ? '▲' : '▼'}</span>
          </div>
        ))}
      </div>
    </Page>
  );
}
