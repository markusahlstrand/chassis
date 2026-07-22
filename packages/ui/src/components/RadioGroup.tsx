import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface RadioGroupProps {
  label?: string;
  /** Options: strings or {value, label, description}. */
  options: Array<string | { value: string; label: string; description?: string }>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  style?: CSSProperties;
}

export function RadioGroup({
  label,
  options,
  value,
  defaultValue,
  onChange,
  style,
}: RadioGroupProps) {
  const [internal, setInternal] = useState(defaultValue);
  const current = value !== undefined ? value : internal;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-medium)',
            color: 'var(--text-primary)',
          }}
        >
          {label}
        </span>
      )}
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const on = current === opt.value;
        return (
          <label
            key={opt.value}
            onClick={() => {
              if (value === undefined) setInternal(opt.value);
              onChange?.(opt.value);
            }}
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                marginTop: 2,
                borderRadius: 'var(--radius-full)',
                flexShrink: 0,
                border: on ? '5px solid var(--brand-600)' : '1px solid var(--border-strong)',
                background: 'var(--surface-card)',
                boxSizing: 'border-box',
                transition: 'border var(--duration-fast) var(--ease-out)',
              }}
            />
            <span>
              <span
                style={{
                  fontSize: 'var(--text-base)',
                  color: 'var(--text-primary)',
                  display: 'block',
                  lineHeight: '20px',
                }}
              >
                {opt.label}
              </span>
              {'description' in opt && opt.description && (
                <span
                  style={{
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-tertiary)',
                    display: 'block',
                    marginTop: 2,
                  }}
                >
                  {opt.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
