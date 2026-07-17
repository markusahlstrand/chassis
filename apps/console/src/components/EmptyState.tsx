import type { CSSProperties, ReactNode } from 'react';

export interface EmptyStateProps {
  /** 18-20px icon node. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Usually a primary Button. */
  action?: ReactNode;
  style?: CSSProperties;
}

export function EmptyState({ icon, title, description, action, style }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '48px 24px',
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {icon && (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-inset)',
            border: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-tertiary)',
            marginBottom: 14,
          }}
        >
          {icon}
        </div>
      )}
      <div
        style={{
          fontSize: 'var(--text-md)',
          fontWeight: 'var(--weight-semibold)',
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </div>
      {description && (
        <div
          style={{
            fontSize: 'var(--text-base)',
            color: 'var(--text-tertiary)',
            marginTop: 4,
            maxWidth: 360,
            lineHeight: 'var(--lh-base)',
          }}
        >
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
