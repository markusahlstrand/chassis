import { useState } from 'react';
import { Button, Input, Tabs } from '@substrat-run/ui';
import { Page } from '../components/layout';
import { card } from '../components/ui';

/** Account settings — Organization tab (screen 1v). Demo, org-scoped. */
export function Settings({ org }: { org: string }) {
  const [tab, setTab] = useState('organization');
  const [name, setName] = useState(org);
  return (
    <Page maxWidth={720}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Settings</div>
      <Tabs
        tabs={[
          { value: 'profile', label: 'Profile' },
          { value: 'organization', label: 'Organization' },
          { value: 'danger', label: 'Danger zone' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'organization' && (
        <>
          <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Input label="Organization name" value={name} onChange={(e) => setName(e.target.value)} hint="Shown in the sidebar and invites." style={{ width: 320 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>Organization slug</div>
              <div style={{ display: 'flex', alignItems: 'center', height: 32, width: 320, border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-primary)', background: 'var(--surface-card)' }}>{org.toLowerCase()}</span>
                <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-tertiary)', background: 'var(--surface-inset)', borderLeft: '1px solid var(--border-subtle)', flex: 1 }}>.substrat.run</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Drives your default app hostnames. Changing it re-issues them.</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13 }}>
              <span style={{ color: 'var(--text-tertiary)', padding: '8px 0' }}>Region</span>
              <span style={{ padding: '8px 0', color: 'var(--text-primary)' }}>EU (Stockholm) <span style={{ color: 'var(--text-tertiary)' }}>— data residency, read-only</span></span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
              <Button>Save</Button>
            </div>
          </div>

          <div style={{ ...card, border: '1px solid var(--status-danger-fg)', padding: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--status-danger-fg)' }}>Delete this organization</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Deprovisions every app and removes all members. Requires typing the org slug.</div>
            </div>
            <Button variant="danger">Delete organization</Button>
          </div>
        </>
      )}

      {tab === 'profile' && (
        <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Input label="Your name" value="Dana Vogel" style={{ width: 320 }} />
          <Input label="Email" value="dana@acme.com" mono style={{ width: 320 }} />
          <div><Button>Save</Button></div>
        </div>
      )}

      {tab === 'danger' && (
        <div style={{ ...card, border: '1px solid var(--status-danger-fg)', padding: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--status-danger-fg)' }}>Delete this organization</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Deprovisions every app and removes all members. Requires typing the org slug.</div>
          </div>
          <Button variant="danger">Delete organization</Button>
        </div>
      )}
    </Page>
  );
}
