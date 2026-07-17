import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface TabsProps {
  /** Tabs: strings or {value, label, count}. */
  tabs: Array<string | { value: string; label: string; count?: number }>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  style?: CSSProperties;
}

function valueOf(tab: TabsProps['tabs'][number]): string {
  return typeof tab === 'string' ? tab : tab.value;
}

export function Tabs({ tabs, value, defaultValue, onChange, style }: TabsProps) {
  const first = tabs[0];
  const [internal, setInternal] = useState(
    defaultValue ?? (first !== undefined ? valueOf(first) : undefined),
  );
  const current = value !== undefined ? value : internal;

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid var(--border-default)',
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {tabs.map((t) => {
        const tab = typeof t === 'string' ? { value: t, label: t } : t;
        const on = current === tab.value;
        return (
          <button
            key={tab.value}
            onClick={() => {
              if (value === undefined) setInternal(tab.value);
              onChange?.(tab.value);
            }}
            style={{
              appearance: 'none',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0 4px',
              height: 38,
              fontSize: 'var(--text-base)',
              fontFamily: 'var(--font-sans)',
              fontWeight: on ? 'var(--weight-medium)' : 'var(--weight-regular)',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
              boxShadow: on ? 'inset 0 -2px 0 var(--brand-600)' : 'none',
              marginRight: 12,
              transition: 'color var(--duration-fast) var(--ease-out)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {tab.label}
              {'count' in tab && tab.count !== undefined && (
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--surface-inset)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-full)',
                    padding: '1px 6px',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  {tab.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
