import { useState } from 'react';
import { Button, Dialog, Input, Select } from '@substrat-run/ui';
import { INTEGRATIONS, APP_FILTER, type Integration } from '../lib/demo';
import { Page } from '../components/layout';
import { card, PageTitle, Pill } from '../components/ui';

/** One integration card — monogram tile, name + status, description, action (screen 1q). */
export function IntegrationCard({ integ, onConnect }: { integ: Integration; onConnect?: () => void }) {
  return (
    <div style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
        {integ.monogram}
      </span>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{integ.name}</span>
          <Pill kind={integ.connected ? 'success' : 'neutral'}>{integ.connected ? 'Connected' : 'Not connected'}</Pill>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{integ.description}</div>
        {integ.usedBy && <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Used by {integ.usedBy}</div>}
      </div>
      <Button variant="secondary" size="sm" onClick={onConnect}>{integ.connected ? 'Manage' : 'Connect'}</Button>
    </div>
  );
}

/** Integrations — account level (screens 1q, 1r). Demo connection store. */
export function Integrations() {
  const [connect, setConnect] = useState<Integration | null>(null);
  return (
    <Page>
      <PageTitle title="Integrations" subtitle="Connections your apps can use. Credentials are stored once, never shown again." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        {INTEGRATIONS.map((i) => (
          <IntegrationCard key={i.name} integ={i} onConnect={() => setConnect(i)} />
        ))}
      </div>

      <Dialog
        open={!!connect}
        title={connect ? (connect.connected ? `Manage ${connect.name}` : `Connect ${connect.name}`) : ''}
        confirmLabel={connect?.connected ? 'Save' : 'Connect'}
        onCancel={() => setConnect(null)}
        onConfirm={() => setConnect(null)}
      >
        {connect && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{connect.monogram}</span>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Stored in the connection vault — apps use it, never see it.</div>
            </div>
            <Input label="Webhook URL" placeholder="https://hooks.slack.com/services/…" mono />
            <Input label="Signing secret" placeholder="••••••••" mono hint="Masked after saving — reveals are audited." />
            <Select label="Available to" options={APP_FILTER} value="All apps" style={{ width: 220 }} />
          </div>
        )}
      </Dialog>
    </Page>
  );
}
