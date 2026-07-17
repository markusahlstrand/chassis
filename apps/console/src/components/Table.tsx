import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface TableColumn<T> {
  header: string;
  /** Row property to display (or use render). */
  key?: keyof T & string;
  render?: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Geist Mono at 12.5px — for IDs, slugs, timestamps. */
  mono?: boolean;
  /** Tertiary text color. */
  muted?: boolean;
  width?: number | string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  onRowClick?: (row: T, index: number) => void;
  emptyText?: string;
  style?: CSSProperties;
}

export function Table<T>({
  columns,
  rows,
  onRowClick,
  emptyText = 'Nothing here yet.',
  style,
}: TableProps<T>) {
  const [hoverIdx, setHoverIdx] = useState(-1);

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-base)',
        ...style,
      }}
    >
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th
              key={i}
              style={{
                textAlign: c.align || 'left',
                padding: '0 16px',
                height: 36,
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-medium)',
                letterSpacing: 'var(--tracking-caps)',
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
                borderBottom: '1px solid var(--border-default)',
                background: 'var(--surface-inset)',
                whiteSpace: 'nowrap',
                width: c.width,
              }}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td
              colSpan={columns.length}
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {emptyText}
            </td>
          </tr>
        )}
        {rows.map((row, ri) => (
          <tr
            key={ri}
            onMouseEnter={() => setHoverIdx(ri)}
            onMouseLeave={() => setHoverIdx(-1)}
            onClick={onRowClick ? () => onRowClick(row, ri) : undefined}
            style={{
              background: hoverIdx === ri ? 'var(--surface-hover)' : 'transparent',
              cursor: onRowClick ? 'pointer' : 'default',
              transition: 'background var(--duration-fast) var(--ease-out)',
            }}
          >
            {columns.map((c, ci) => (
              <td
                key={ci}
                style={{
                  padding: '0 16px',
                  height: 'var(--table-row-h)',
                  textAlign: c.align || 'left',
                  borderBottom: ri === rows.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                  fontFamily: c.mono ? 'var(--font-mono)' : 'var(--font-sans)',
                  fontSize: c.mono ? 'var(--text-sm)' : 'var(--text-base)',
                  color: c.muted ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.render ? c.render(row, ri) : c.key ? String(row[c.key] ?? '') : null}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
