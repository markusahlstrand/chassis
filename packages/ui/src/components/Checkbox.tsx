import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface CheckboxProps {
  label: string;
  /** Secondary line under the label. */
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: CSSProperties;
}

export function Checkbox({
  label,
  description,
  checked,
  defaultChecked,
  onChange,
  disabled,
  style,
}: CheckboxProps) {
  const [internal, setInternal] = useState(!!defaultChecked);
  const isOn = checked !== undefined ? checked : internal;

  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setInternal(!isOn);
    onChange?.(!isOn);
  };

  return (
    <label
      onClick={toggle}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          marginTop: 2,
          borderRadius: 'var(--radius-xs)',
          flexShrink: 0,
          border: '1px solid ' + (isOn ? 'var(--brand-600)' : 'var(--border-strong)'),
          background: isOn ? 'var(--brand-600)' : 'var(--surface-card)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background var(--duration-fast) var(--ease-out)',
        }}
      >
        {isOn && (
          <svg viewBox="0 0 12 12" width="10" height="10">
            <path
              d="M2.5 6.5l2.5 2.5 4.5-5"
              fill="none"
              stroke="#fff"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      <span>
        <span
          style={{
            fontSize: 'var(--text-base)',
            color: 'var(--text-primary)',
            display: 'block',
            lineHeight: '20px',
          }}
        >
          {label}
        </span>
        {description && (
          <span
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-tertiary)',
              display: 'block',
              marginTop: 2,
            }}
          >
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
