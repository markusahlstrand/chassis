import { useState } from 'react';
import { Button, Dialog, Input, Select } from '@substrat-run/ui';
import { DOMAINS, APP_FILTER, type DomainRow } from '../lib/demo';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, CopyButton, MonoTag, PageTitle, Pill, RowActions } from '../components/ui';

const COLS = '2.2fr 1.4fr 1.4fr 1fr 40px';

/** Domains — account level (screens 1o, 1p). Demo hostname bindings. */
export function Domains() {
  const [add, setAdd] = useState(false);
  const failed = DOMAINS.find((d) => d.status === 'failed');
  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <PageTitle title="Domains" subtitle={<>Every app is already live on its <span style={{ fontFamily: 'var(--font-mono)' }}>*.substrat.run</span> hostname — custom domains bind on top.</>} />
        <div style={{ flex: 1 }} />
        <Button icon={<Ic name="plus" />} onClick={() => setAdd(true)}>Add domain</Button>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Hostname</span><span>App</span><span>Status</span><span>Added</span><span />
        </div>
        {DOMAINS.map((d) => (
          <DomainRowView key={d.hostname} d={d} />
        ))}
        {failed?.problem && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '0 16px 14px', background: 'var(--status-danger-bg)', borderRadius: 6, padding: '10px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
            <span style={{ flex: 1 }}>
              The CNAME for <span style={{ fontFamily: 'var(--font-mono)' }}>{failed.hostname}</span> points to <span style={{ fontFamily: 'var(--font-mono)' }}>{failed.problem.current}</span> — it should be <span style={{ fontFamily: 'var(--font-mono)' }}>{failed.problem.expected}</span>. Fix the record, then check again.
            </span>
            <span style={{ fontWeight: 500, textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap' }}>Check again</span>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Default hostnames (<span style={{ fontFamily: 'var(--font-mono)' }}>acme-hr.substrat.run</span>, …) are managed automatically and not listed here.</div>

      <AddDomainDialog open={add} onClose={() => setAdd(false)} />
    </Page>
  );
}

function DomainRowView({ d }: { d: DomainRow }) {
  const last = d.status !== 'failed';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, borderBottom: last ? '1px solid var(--border-subtle)' : 'none' }}>
      {d.status === 'active' ? (
        <a href="#" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>{d.hostname}<Ic name="external" size={11} /></a>
      ) : (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{d.hostname}</span>
      )}
      <a href="#" style={{ fontSize: 13 }}>{d.app}</a>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {d.status === 'active' && <><Pill kind="success">Active</Pill>{d.primary && <MonoTag color="var(--text-tertiary)">primary</MonoTag>}</>}
        {d.status === 'pending' && <><Pill kind="warning" pulse>Pending verification</Pill><span style={{ fontSize: 12, color: 'var(--text-brand)', cursor: 'pointer' }}>Check again</span></>}
        {d.status === 'failed' && <Pill kind="danger">Verification failed</Pill>}
      </span>
      <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{d.added}</span>
      <RowActions />
    </div>
  );
}

function AddDomainDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title="Add a domain" confirmLabel="Verify now" cancelLabel="Close" onCancel={onClose} onConfirm={onClose} width={500}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: -8 }}>Point <span style={{ fontFamily: 'var(--font-mono)' }}>legal.acme.com</span> at Acme Legal, then add this record with your DNS provider.</div>
        <Input label="Domain" placeholder="legal.acme.com" mono />
        <div style={{ background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', display: 'grid', gridTemplateColumns: '64px 1fr 24px', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Type</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>CNAME</span><span />
          <span style={{ color: 'var(--text-tertiary)' }}>Name</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>legal</span><CopyButton text="legal" />
          <span style={{ color: 'var(--text-tertiary)' }}>Value</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>edge.substrat.run</span><CopyButton text="edge.substrat.run" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Pill kind="warning" pulse>Waiting for DNS</Pill>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Last checked 40s ago — propagation can take up to an hour.</span>
        </div>
      </div>
    </Dialog>
  );
}
