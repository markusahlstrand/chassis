import type { ReactNode } from 'react';

/** Map a leave-type key to the shape-coded dot class (colourblind-safe). */
export function typeClass(kind: string): string {
  if (kind === 'vacation') return 'vacation';
  if (kind === 'sick' || kind === 'vab' || kind === 'baja') return 'sick';
  if (kind === 'parental') return 'parental';
  return 'unpaid';
}

export function TypeDot({ kind }: { kind: string }) {
  return <span className={`tdot ${typeClass(kind)}`} aria-hidden />;
}

export function Chip({ kind, children }: { kind: 'pending' | 'approved' | 'queued' | 'action'; children: ReactNode }) {
  return <span className={`chip ${kind}`}>{children}</span>;
}

/** Status → chip kind + label, the global vocabulary from the handover. */
export function statusChip(status: string): { kind: 'pending' | 'approved' | 'queued' | 'action'; label: string } {
  switch (status) {
    case 'approved':
      return { kind: 'approved', label: 'Approved' };
    case 'exported':
      return { kind: 'approved', label: 'Reimbursed' };
    case 'rejected':
      return { kind: 'pending', label: 'Rejected' };
    case 'requested':
    case 'submitted':
      return { kind: 'pending', label: 'Pending' };
    default:
      return { kind: 'queued', label: status };
  }
}

/** The vacation ring — fraction 0..1, drawn from 12 o'clock, rounded cap. */
export function Ring({ size, remaining, total }: { size: number; remaining: number; total: number }) {
  const stroke = size >= 100 ? 10 : 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--ring-fill)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
      />
    </svg>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'pill';
}) {
  const cls = variant === 'secondary' ? 'btn secondary' : variant === 'pill' ? 'btn pill' : 'btn';
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const btn: React.CSSProperties = {
    width: 58,
    height: 58,
    borderRadius: 999,
    display: 'grid',
    placeItems: 'center',
    fontSize: 26,
    fontWeight: 600,
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22 }}>
      <button
        style={{ ...btn, background: 'var(--accent-tint)', color: 'var(--accent-dark)' }}
        onClick={() => onChange(Math.max(0, +(value - 0.5).toFixed(1)))}
        aria-label="less"
      >
        −
      </button>
      <div style={{ textAlign: 'center', minWidth: 96 }}>
        <div className="num" style={{ fontSize: 46, fontWeight: 700, lineHeight: 1 }}>
          {value.toFixed(1)}
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
          hours
        </div>
      </div>
      <button
        style={{ ...btn, background: 'var(--accent)', color: 'var(--btn-fg)' }}
        onClick={() => onChange(+(value + 0.5).toFixed(1))}
        aria-label="more"
      >
        +
      </button>
    </div>
  );
}

// -- line-glyph tab icons (24px grid, 1.7px stroke) --------------------------

const iconProps = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const icons: Record<string, ReactNode> = {
  home: (
    <svg {...iconProps}>
      <path d="M4 11l8-6 8 6" />
      <path d="M6 10v9h12v-9" />
    </svg>
  ),
  timeoff: (
    <svg {...iconProps}>
      <rect x="4" y="5" width="16" height="16" rx="2.5" />
      <path d="M4 9h16M8 3v4M16 3v4" />
    </svg>
  ),
  timesheet: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  ),
  expenses: (
    <svg {...iconProps}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  ),
  me: (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
    </svg>
  ),
  camera: (
    <svg {...iconProps}>
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  ),
  chevron: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  inbox: (
    <svg {...iconProps}>
      <path d="M4 5h16v14H4z" />
      <path d="M4 13h5a3 3 0 006 0h5" />
    </svg>
  ),
  people: (
    <svg {...iconProps}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c1-3.5 3.2-5 6-5s5 1.5 6 5" />
      <path d="M16 5.5a3 3 0 010 5.8M21 20c-.7-2.6-2-3.8-3.8-4.4" />
    </svg>
  ),
};
