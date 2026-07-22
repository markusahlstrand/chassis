import { useState } from 'react';
import { Button, Dialog, Select, Switch, Tag } from '@substrat-run/ui';
import { MEMBERS, ROLE_MATRIX, ROLE_OPTS, type Member } from '../lib/demo';
import { Ic } from '../lib/icons';
import { Avatar } from '../components/DashShell';
import { Page } from '../components/layout';
import { card, MonoTag, PageTitle, Pill, RowActions } from '../components/ui';

const COLS = '2.4fr 1fr 1fr 1fr 40px';
const STATUS: Record<Member['status'], { kind: 'success' | 'warning' | 'neutral'; label: string }> = {
  active: { kind: 'success', label: 'Active' },
  invited: { kind: 'warning', label: 'Invited' },
  revoked: { kind: 'neutral', label: 'Revoked' },
};

/** Team roster + roles matrix (screens 1m, 1n). Demo — an invite is a grant. */
export function Team() {
  const [showRevoked, setShowRevoked] = useState(true);
  const [invite, setInvite] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(true);
  const rows = MEMBERS.filter((m) => showRevoked || m.status !== 'revoked');

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <PageTitle title="Team" subtitle="An invitation is a grant — every change here lands in the audit log." />
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>
          Show revoked <Switch checked={showRevoked} onChange={setShowRevoked} />
        </label>
        <Button icon={<Ic name="plus" />} onClick={() => setInvite(true)}>Invite</Button>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Member</span><span>Role</span><span>Status</span><span>Added</span><span />
        </div>
        {rows.map((m, i) => {
          const s = STATUS[m.status];
          return (
            <div key={m.email} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 48, padding: '0 16px', fontSize: 13, borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-subtle)', opacity: m.status === 'revoked' ? 0.55 : 1 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar seed={m.name} tone={m.avatar} size={26} />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{m.name} {m.you && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400 }}>(you)</span>}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{m.email}</span>
                </span>
              </span>
              <span><MonoTag>{m.role}</MonoTag></span>
              <span><Pill kind={s.kind}>{s.label}</Pill></span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{m.added}</span>
              <RowActions />
            </div>
          );
        })}
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div onClick={() => setMatrixOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: matrixOpen ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Roles &amp; permissions</span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>what each role can do — mirrors PERMISSIONS.md</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', transform: matrixOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}><Ic name="chevronDown" size={14} color="var(--text-tertiary)" /></span>
        </div>
        {matrixOpen && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '2.4fr 1fr 1fr 1fr 1fr', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
              <span>Permission</span><span>Owner</span><span>Admin</span><span>Member</span><span>Viewer</span>
            </div>
            {ROLE_MATRIX.map((p, i) => (
              <div key={p.label} style={{ display: 'grid', gridTemplateColumns: '2.4fr 1fr 1fr 1fr 1fr', alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, color: 'var(--text-primary)', borderBottom: i === ROLE_MATRIX.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                <span>{p.label}</span>
                {[p.owner, p.admin, p.member, p.viewer].map((v, j) => (
                  <span key={j} style={{ color: v ? 'var(--status-success-fg)' : 'var(--text-placeholder)' }}>{v ? '✓' : '—'}</span>
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      <Dialog open={invite} title="Invite people to Acme" confirmLabel="Send invite" onCancel={() => setInvite(false)} onConfirm={() => setInvite(false)} width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: -8 }}>They’ll get an email with a link to join your workspace.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>Email addresses</div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, minHeight: 40, padding: '6px 10px', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)' }}>
              <Tag mono onRemove={() => {}}>priya@acme.com</Tag>
              <span style={{ fontSize: 13, color: 'var(--text-placeholder)' }}>Add another…</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Select label="Role" options={ROLE_OPTS} value="Member" style={{ width: 220 }} />
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Members can use apps and edit content, but can’t manage apps, domains, or people.</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', background: 'var(--surface-inset)', borderRadius: 6, padding: '8px 12px' }}>Per-app access is coming — today an invite grants a workspace-wide role.</div>
        </div>
      </Dialog>
    </Page>
  );
}
