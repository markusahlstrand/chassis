import type { CSSProperties, ReactNode } from 'react';

export interface TagProps {
  /** Render in Geist Mono — for kinds, slugs, package names. */
  mono?: boolean;
  /** Show a remove ×. */
  onRemove?: () => void;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Tag({ mono, onRemove, children, style }: TagProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        borderRadius: 'var(--radius-xs)',
        background: 'var(--surface-inset)',
        border: '1px solid var(--border-default)',
        color: 'var(--text-secondary)',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 'var(--text-xs)',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
      {onRemove && (
        <span
          onClick={onRemove}
          style={{ cursor: 'pointer', display: 'inline-flex', color: 'var(--text-tertiary)' }}
        >
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </span>
      )}
    </span>
  );
}
