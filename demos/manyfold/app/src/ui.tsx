import type { CSSProperties, ReactNode } from 'react';
import type { EntryStatus } from './api';

// Manyfold UI primitives — token-driven inline styles, no external CSS beyond tokens.css.
// Kept local (the demo-app convention) rather than depending on @substrat-run/ui.

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
}) {
  const { variant = 'ghost', disabled, size = 'md' } = props;
  const pad = size === 'sm' ? '5px 10px' : '8px 15px';
  const base: CSSProperties = {
    font: 'inherit',
    fontSize: size === 'sm' ? 12.5 : 13,
    fontWeight: 600,
    padding: pad,
    borderRadius: 'var(--r-btn)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: '1px solid transparent',
    transition: 'background 160ms ease, border-color 160ms ease',
  };
  const style: CSSProperties = disabled
    ? { ...base, background: 'var(--wash)', color: 'var(--faint)', borderColor: 'transparent' }
    : variant === 'primary'
      ? { ...base, background: 'var(--accent)', color: 'var(--on-accent)' }
      : { ...base, background: 'transparent', color: 'var(--ink)', borderColor: 'var(--border2)' };
  return (
    <button style={style} onClick={disabled ? undefined : props.onClick} disabled={disabled} title={props.title}>
      {props.children}
    </button>
  );
}

const STATUS_LABEL: Record<EntryStatus, string> = {
  draft: 'draft',
  in_review: 'in review',
  approved: 'approved',
  published: 'published',
  unpublished: 'unpublished',
  archived: 'archived',
};
const STATUS_VAR: Record<EntryStatus, string> = {
  draft: 'draft',
  in_review: 'review',
  approved: 'approved',
  published: 'published',
  unpublished: 'archived',
  archived: 'archived',
};

export function StatusBadge({ status }: { status: EntryStatus }) {
  const v = STATUS_VAR[status];
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        padding: '2px 9px',
        borderRadius: 'var(--r-pill)',
        color: `var(--st-${v}-fg)`,
        background: `var(--st-${v}-bg)`,
        whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Pill({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        font: 'inherit',
        fontSize: 12.5,
        fontWeight: 500,
        padding: '4px 12px',
        borderRadius: 'var(--r-pill)',
        cursor: 'pointer',
        border: '1px solid var(--border)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-card)',
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Mono({ children, style, title }: { children: ReactNode; style?: CSSProperties; title?: string }) {
  return <span title={title} style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', ...style }}>{children}</span>;
}

export function ColHead({ children }: { children: ReactNode }) {
  return (
    <th
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--faint)',
        textAlign: 'left',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {children}
    </th>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted)' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>{title}</div>
      {hint && <div style={{ fontSize: 13 }}>{hint}</div>}
    </div>
  );
}
