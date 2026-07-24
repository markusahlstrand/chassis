import type { Persona, Site } from './api';
import { Card, ColHead, Empty, Mono } from './ui';

// Group C — Members & roles (per site) and the Asset library.

const ROLE_COLOR: Record<string, { fg: string; bg: string }> = {
  admin: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  publisher: { fg: 'var(--st-published-fg)', bg: 'var(--st-published-bg)' },
  editor: { fg: 'var(--st-approved-fg)', bg: 'var(--st-approved-bg)' },
  author: { fg: 'var(--st-review-fg)', bg: 'var(--st-review-bg)' },
  viewer: { fg: 'var(--st-draft-fg)', bg: 'var(--st-draft-bg)' },
};

function RoleChip({ role }: { role?: string }) {
  if (!role) return <span style={{ color: 'var(--faint)', fontSize: 12 }}>—</span>;
  const c = ROLE_COLOR[role] ?? ROLE_COLOR.viewer;
  return <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 'var(--r-pill)', color: c.fg, background: c.bg }}>{role}</span>;
}

export function MembersView({ personas, sites }: { personas: Persona[]; sites: Site[] }) {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Members &amp; roles</h1>
        <div style={{ color: 'var(--muted)', marginTop: 4 }}>Roles are held <strong>per site</strong> — the same login is a different authority in each scope (K-22).</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 16 }}>
        <Card style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
            <thead>
              <tr>
                <ColHead>Member</ColHead>
                {sites.map((s) => <ColHead key={s.slug}>{s.name}</ColHead>)}
              </tr>
            </thead>
            <tbody>
              {personas.map((p) => (
                <tr key={p.id}>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name}</div>
                    <Mono style={{ fontSize: 10.5 }}>{p.id.slice(0, 10)}…</Mono>
                  </td>
                  {sites.map((s) => (
                    <td key={s.slug} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}><RoleChip role={p.roles[s.slug]} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 10 }}>The role ladder</div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.8 }}>
            <li><strong>Author</strong> — drafts &amp; submits</li>
            <li><strong>Editor</strong> — + reviews</li>
            <li><strong>Publisher</strong> — + publishes</li>
            <li><strong>Admin</strong> — + manages members &amp; models</li>
            <li><strong>Viewer</strong> — read only</li>
          </ul>
          <div style={{ marginTop: 14, fontSize: 12, color: 'var(--faint)' }}>
            Inviting members writes per-scope role grants (assignScopeRole) — the productization tracked in the design.
          </div>
        </Card>
      </div>
    </div>
  );
}

export function AssetLibrary() {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Media</h1>
        <div style={{ color: 'var(--muted)', marginTop: 4 }}>Assets are referenced by <code>assetRef</code> fields and resolved at delivery.</div>
      </div>
      <Card>
        <Empty
          title="No asset store wired yet"
          hint="Media uploads land through an R2 storage connector (design phase 2). The grid below is the designed shell; assetRef fields accept ids in the meantime."
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12, marginTop: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ aspectRatio: '1', borderRadius: 'var(--r-input)', background: 'repeating-linear-gradient(45deg, var(--wash), var(--wash) 8px, var(--surface) 8px, var(--surface) 16px)', border: '1px solid var(--border)', display: 'flex', alignItems: 'flex-end', padding: 8 }}>
              <Mono style={{ fontSize: 10 }}>asset-{i + 1}.png</Mono>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
