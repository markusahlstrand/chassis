import type { CSSProperties, ReactNode } from 'react';

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  /** Render value in Geist Mono. */
  mono?: boolean;
}

export interface KeyValueProps {
  items: KeyValueItem[];
  /** Grid columns. Default 1. */
  columns?: number;
  style?: CSSProperties;
}

export function KeyValue({ items, columns = 1, style }: KeyValueProps) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(' + columns + ', minmax(0,1fr))',
        gap: '12px 24px',
        margin: 0,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {items.map((it, i) => (
        <div key={i}>
          <dt
            style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 'var(--weight-medium)',
              letterSpacing: 'var(--tracking-caps)',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              marginBottom: 4,
            }}
          >
            {it.label}
          </dt>
          <dd
            style={{
              margin: 0,
              fontSize: it.mono ? 'var(--text-sm)' : 'var(--text-base)',
              fontFamily: it.mono ? 'var(--font-mono)' : 'var(--font-sans)',
              color: 'var(--text-primary)',
            }}
          >
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
