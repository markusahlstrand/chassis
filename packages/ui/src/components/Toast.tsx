import type { CSSProperties, ReactNode } from 'react';

export interface ToastProps {
  status?: 'success' | 'danger' | 'info';
  title: string;
  detail?: string;
  /** Inline action label, e.g. "Undo" or "View event". */
  action?: string;
  onAction?: () => void;
  style?: CSSProperties;
}

const iconFor: Record<NonNullable<ToastProps['status']>, ReactNode> = {
  success: (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <circle cx="8" cy="8" r="7" fill="var(--status-success-dot)" />
      <path
        d="M5 8.2l2 2 4-4.5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  danger: (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <circle cx="8" cy="8" r="7" fill="var(--status-danger-dot)" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <circle cx="8" cy="8" r="7" fill="var(--status-info-dot)" />
      <path d="M8 7v4M8 5v.1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
};

export function Toast({ status = 'info', title, detail, action, onAction, style }: ToastProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        width: 360,
        padding: '12px 14px',
        background: 'var(--surface-raised)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-popover)',
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>{iconFor[status]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--text-base)',
            fontWeight: 'var(--weight-medium)',
            color: 'var(--text-primary)',
          }}
        >
          {title}
        </div>
        {detail && (
          <div
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-tertiary)',
              marginTop: 2,
            }}
          >
            {detail}
          </div>
        )}
      </div>
      {action && (
        <button
          onClick={onAction}
          style={{
            appearance: 'none',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-medium)',
            color: 'var(--text-link)',
            padding: 0,
            marginTop: 1,
          }}
        >
          {action}
        </button>
      )}
    </div>
  );
}
