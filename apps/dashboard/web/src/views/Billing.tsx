import { Badge, Button } from '@substrat-run/ui';
import { ENTITLEMENTS, INVOICES } from '../lib/demo';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, HonestyBanner, PageTitle, Pill } from '../components/ui';

/** Billing — the read-only plan (screen 1s) + the design-ahead full billing (1t). */
export function Billing() {
  return (
    <Page maxWidth={960}>
      <PageTitle title="Plan" subtitle="What your plan includes. Self-serve plan changes aren’t enabled yet." />

      <div style={{ ...card, padding: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>Team</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Documents and Work Orders engines, up to 5 apps and 10 members.</div>
        </div>
        <Button variant="secondary">Contact us to change plan</Button>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Entitlement</span><span>Included</span><span>Used</span>
        </div>
        {ENTITLEMENTS.map((e, i) => (
          <div key={e.label} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr', alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, color: 'var(--text-primary)', borderBottom: i === ENTITLEMENTS.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {e.accent && <span style={{ width: 8, height: 8, borderRadius: '50%', background: e.accent }} />}{e.label}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {e.included ? <span style={{ color: 'var(--status-success-fg)' }}>✓</span> : <span style={{ color: 'var(--text-placeholder)' }}>—</span>}
              {e.upgrade && <Badge status="brand" dot={false}>Upgrade</Badge>}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: e.used === '—' ? 'var(--text-placeholder)' : 'var(--text-secondary)' }}>{e.used}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>These entitlements gate marketplace deploys and repo imports — the same “Upgrade” badge appears there.</div>

      {/* Design-ahead: full billing (screen 1t), clearly not yet enabled. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>Billing</span>
        <Badge status="neutral" dot={false}>Not yet enabled</Badge>
      </div>
      <HonestyBanner>Payments aren’t wired yet — plan changes go through us. This shows the intended shape.</HonestyBanner>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 10, opacity: 0.75 }}>
          <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Payment method</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 36, height: 24, borderRadius: 4, border: '1px solid var(--border-default)', background: 'var(--surface-inset)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-secondary)' }}>VISA</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>•••• 4242</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>expires 09/28</span>
          </div>
          <div><Button variant="secondary" size="sm" disabled>Update card</Button></div>
        </div>
        <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 10, opacity: 0.75 }}>
          <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Current period</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ fontSize: 28, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>€480.00</span><span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Jul 1 – Jul 31</span></div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Team plan €400 · 2 extra domains €80 · usage included</div>
        </div>
      </div>
      <div style={{ ...card, overflow: 'hidden', opacity: 0.75 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 40px', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Invoice</span><span style={{ textAlign: 'right' }}>Amount</span><span>Status</span><span>Date</span><span />
        </div>
        {INVOICES.map((inv, i) => (
          <div key={inv.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 40px', alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, borderBottom: i === INVOICES.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{inv.id}</span>
            <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{inv.amount}</span>
            <span><Pill kind="success">Paid</Pill></span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{inv.date}</span>
            <span style={{ color: 'var(--text-tertiary)' }}><Ic name="download" size={14} /></span>
          </div>
        ))}
      </div>
    </Page>
  );
}
