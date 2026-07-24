import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ContentTypeDef, type EntryListItem, type EntryStatus, type FieldDef } from './api';
import { Button, Card, Mono, StatusBadge } from './ui';

// The field-driven entry form: one control per field type, built from the content-type
// definition. Used for both create (new entry) and edit (a new draft revision).

const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 13.5,
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--r-input)',
  border: '1px solid var(--border2)',
  background: 'var(--surface)',
  color: 'var(--ink)',
};

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function EntryForm(props: {
  def: ContentTypeDef;
  initial?: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  error?: string;
}) {
  const [body, setBody] = useState<Record<string, unknown>>(props.initial ?? {});
  const set = (name: string, value: unknown) => setBody((b) => ({ ...b, [name]: value }));

  // Auto-derive slug from its source field until the user edits the slug directly.
  const [slugTouched, setSlugTouched] = useState(!!props.initial);
  useEffect(() => {
    if (props.def.slugField && !slugTouched) {
      const src = props.def.fields[props.def.slugField]?.source;
      if (src && typeof body[src] === 'string') set(props.def.slugField, slugify(body[src] as string));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body[props.def.slugField ? props.def.fields[props.def.slugField]?.source ?? '' : '']]);

  const clean = (): Record<string, unknown> => {
    // Drop empty optionals so the backend Zod (optional) is satisfied.
    const out: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(props.def.fields)) {
      const v = body[name];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
        if (f.required) out[name] = v ?? '';
        continue;
      }
      out[name] = v;
    }
    return out;
  };

  return (
    <Card style={{ maxWidth: 720 }}>
      {props.error && (
        <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>
          {props.error}
        </div>
      )}
      {Object.entries(props.def.fields).map(([name, f]) => (
        <div key={name} style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
            {name}{' '}
            <Mono style={{ fontSize: 11 }}>
              {f.type}{f.target ? `(${f.target})` : ''}{f.required ? ' · required' : ''}
            </Mono>
          </label>
          <FieldControl
            name={name}
            f={f}
            value={body[name]}
            onChange={(v) => {
              if (props.def.slugField === name) setSlugTouched(true);
              set(name, v);
            }}
          />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button variant="primary" onClick={() => props.onSubmit(clean())}>{props.submitLabel}</Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}

function FieldControl({ name, f, value, onChange }: { name: string; f: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (f.type) {
    case 'richText':
      return <textarea style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'bool':
      return (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {value ? 'yes' : 'no'}
        </label>
      );
    case 'int':
      return <input type="number" style={inputStyle} value={(value as number) ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
    case 'date':
      return <input type="date" style={inputStyle} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'enum':
      return (
        <select style={inputStyle} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">—</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'textArray':
      return <input style={inputStyle} placeholder="comma,separated" value={Array.isArray(value) ? (value as string[]).join(', ') : ''} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
    case 'assetRef':
      return <input style={{ ...inputStyle, fontFamily: 'var(--mono)', fontSize: 12 }} placeholder="asset id (mock — no asset store wired yet)" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'assetRefMany':
      return <input style={{ ...inputStyle, fontFamily: 'var(--mono)', fontSize: 12 }} placeholder="asset ids, comma-separated" value={Array.isArray(value) ? (value as string[]).join(', ') : ''} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
    case 'ref':
    case 'refMany':
      return <ReferenceField f={f} many={f.type === 'refMany'} value={value} onChange={onChange} fieldName={name} />;
    default:
      return <input style={inputStyle} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
}

// ── Reference picker (the linking UX) ────────────────────────────────────────

function ReferenceField({ f, many, value, onChange }: { f: FieldDef; many: boolean; value: unknown; onChange: (v: unknown) => void; fieldName: string }) {
  const ids: string[] = many ? ((value as string[]) ?? []) : value ? [value as string] : [];
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<EntryListItem[]>([]);
  useEffect(() => {
    if (open && f.target) api.listEntries({ typeKey: f.target }).then(setEntries).catch(() => setEntries([]));
  }, [open, f.target]);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const chip = (id: string) => {
    const e = byId.get(id);
    const draft = e && e.status !== 'published';
    return (
      <span key={id} title={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border2)', background: draft ? 'var(--st-review-bg)' : 'var(--wash)', fontSize: 12 }}>
        {draft && <span title="won't resolve at delivery until published">⚠</span>}
        {e?.title ?? <Mono>{id.slice(0, 8)}…</Mono>}
        <button onClick={() => onChange(many ? ids.filter((x) => x !== id) : undefined)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
      </span>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {ids.map(chip)}
        <Button size="sm" onClick={() => setOpen(true)}>{many ? '+ link' : ids.length ? 'change' : '+ link'}</Button>
      </div>
      {open && (
        <ReferenceModal
          target={f.target ?? ''}
          many={many}
          selected={ids}
          entries={entries}
          onDone={(next) => { onChange(many ? next : next[0]); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ReferenceModal(props: { target: string; many: boolean; selected: string[]; entries: EntryListItem[]; onDone: (ids: string[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<string[]>(props.selected);
  const toggle = (id: string) => setSel((s) => (props.many ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  return (
    <div onClick={props.onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 460, maxHeight: '80vh', overflow: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', padding: 16, boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Link {props.target}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>References are by stable id — a draft target won't resolve at delivery until it's published.</div>
        {props.entries.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '12px 0' }}>No {props.target} entries in this site.</div>}
        {props.entries.map((e) => {
          const on = sel.includes(e.id);
          const draft = e.status !== 'published';
          return (
            <div key={e.id} onClick={() => toggle(e.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-input)', cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'transparent', marginBottom: 2 }}>
              <input type="checkbox" readOnly checked={on} />
              <span style={{ flex: 1, fontSize: 13.5 }}>{e.title}</span>
              <StatusBadge status={e.status as EntryStatus} />
              {draft && <span title="draft — won't resolve at delivery" style={{ color: 'var(--st-review-fg)' }}>⚠</span>}
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => props.onDone(sel)}>Link {props.many ? sel.length : ''}</Button>
        </div>
      </div>
    </div>
  );
}
