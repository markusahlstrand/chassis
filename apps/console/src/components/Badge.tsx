import type { CSSProperties, ReactNode } from 'react';

export interface BadgeProps {
  /** Semantic status. Default 'neutral'. */
  status?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';
  /** Show the leading status dot. Default true. */
  dot?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

/** [background, foreground, dot] */
const map: Record<NonNullable<BadgeProps['status']>, readonly [string, string, string]> = {
  success: ['var(--status-success-bg)', 'var(--status-success-fg)', 'var(--status-success-dot)'],
  warning: ['var(--status-warning-bg)', 'var(--status-warning-fg)', 'var(--status-warning-dot)'],
  danger: ['var(--status-danger-bg)', 'var(--status-danger-fg)', 'var(--status-danger-dot)'],
  info: ['var(--status-info-bg)', 'var(--status-info-fg)', 'var(--status-info-dot)'],
  neutral: ['var(--status-neutral-bg)', 'var(--status-neutral-fg)', 'var(--status-neutral-dot)'],
  brand: ['var(--surface-brand-subtle)', 'var(--text-brand)', 'var(--brand-500)'],
};

export function Badge({ status = 'neutral', dot = true, children, style }: BadgeProps) {
  const [bg, fg, dotColor] = map[status];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 20,
        padding: '0 8px',
        borderRadius: 'var(--radius-full)',
        background: bg,
        color: fg,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--weight-medium)',
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}
