import type { CSSProperties, ReactNode } from 'react';

export interface CardProps {
  title?: string;
  description?: string;
  /** Header-right action nodes (buttons). */
  actions?: ReactNode;
  /** Inset footer strip (meta text, links). */
  footer?: ReactNode;
  /** Body padding in px. Default 16. Use 0 for tables. */
  padding?: number | string;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Card({
  title,
  description,
  actions,
  footer,
  padding = 16,
  children,
  style,
}: CardProps) {
  return (
    <div
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-xs)',
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 'var(--text-md)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                letterSpacing: 'var(--tracking-tight)',
              }}
            >
              {title}
            </div>
            {description && (
              <div
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-tertiary)',
                  marginTop: 2,
                }}
              >
                {description}
              </div>
            )}
          </div>
          {actions && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
        </div>
      )}
      <div style={{ padding }}>{children}</div>
      {footer && (
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--surface-inset)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-tertiary)',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
