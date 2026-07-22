import { Fragment } from 'react';
import type { CSSProperties } from 'react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
  /** Mono for slugs. */
  mono?: boolean;
}

export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  style?: CSSProperties;
}

export function Breadcrumbs({ items, style }: BreadcrumbsProps) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        ...style,
      }}
    >
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <span style={{ color: 'var(--gray-300)' }}>/</span>}
            <a
              href={it.href || '#'}
              onClick={(e) => {
                if (!it.href) e.preventDefault();
                it.onClick?.();
              }}
              style={{
                color: last ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontWeight: last ? 'var(--weight-medium)' : 'var(--weight-regular)',
                textDecoration: 'none',
                fontFamily: it.mono ? 'var(--font-mono)' : 'var(--font-sans)',
              }}
            >
              {it.label}
            </a>
          </Fragment>
        );
      })}
    </nav>
  );
}
