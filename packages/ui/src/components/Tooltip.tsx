import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}

const positions: Record<NonNullable<TooltipProps['side']>, CSSProperties> = {
  top: { bottom: '100%', left: '50%', transform: 'translate(-50%,-6px)' },
  bottom: { top: '100%', left: '50%', transform: 'translate(-50%,6px)' },
  right: { left: '100%', top: '50%', transform: 'translate(6px,-50%)' },
  left: { right: '100%', top: '50%', transform: 'translate(-6px,-50%)' },
};

export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          style={{
            position: 'absolute',
            zIndex: 50,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            background: 'var(--surface-inverse)',
            color: 'var(--text-inverse)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xs)',
            lineHeight: '16px',
            padding: '5px 8px',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            ...positions[side],
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
