import { useEffect, useMemo, useState } from 'react';
import { Ic } from '../lib/icons';
import { PALETTE_ACTIONS } from '../lib/demo';
import type { AppCardData } from './AppCard';

/**
 * The ⌘K palette (screen 1w): 560px, 80px from top. Filters apps + actions by
 * the query, arrow-key navigable, ↵ opens, esc closes.
 */
export interface PaletteApp extends Pick<AppCardData, 'name' | 'accent' | 'status'> {
  host: string | null;
  onOpen: () => void;
}

export function CommandPalette({
  apps,
  onClose,
  onAction,
}: {
  apps: PaletteApp[];
  onClose: () => void;
  onAction: (label: string) => void;
}) {
  const [q, setQ] = useState('');

  const appMatches = useMemo(
    () => apps.filter((a) => a.name.toLowerCase().includes(q.toLowerCase())),
    [apps, q],
  );
  const actionMatches = useMemo(
    () => PALETTE_ACTIONS.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())),
    [q],
  );

  const flat = useMemo(
    () => [
      ...appMatches.map((a) => ({ kind: 'app' as const, run: a.onOpen })),
      ...actionMatches.map((a) => ({ kind: 'action' as const, run: () => onAction(a.label) })),
    ],
    [appMatches, actionMatches, onAction],
  );
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, flat.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        flat[sel]?.run();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, sel, onClose]);

  let idx = -1;
  const rowStyle = (i: number) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 40,
    padding: '0 16px',
    margin: '0 8px',
    borderRadius: 6,
    fontSize: 13,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    background: i === sel ? 'var(--surface-active)' : 'transparent',
  });

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(14,16,23,0.4)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92vw', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-popover)', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 48, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Ic name="search" size={15} color="var(--text-tertiary)" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search apps and actions…"
            style={{ flex: 1, border: 0, outline: 'none', background: 'transparent', fontSize: 14, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)' }}
          />
        </div>

        {appMatches.length > 0 && <GroupLabel>Apps</GroupLabel>}
        {appMatches.map((a) => {
          idx++;
          const i = idx;
          return (
            <div
              key={a.name}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                a.onOpen();
                onClose();
              }}
              style={rowStyle(i)}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.accent }} />
              <span style={{ fontWeight: 500 }}>{a.name}</span>
              {a.status === 'provisioning' ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--status-info-fg)' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--status-info-dot)', animation: 'sub-pulse 1.6s ease-in-out infinite' }} />
                  provisioning
                </span>
              ) : (
                a.host && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{a.host}</span>
              )}
              <div style={{ flex: 1 }} />
              {i === sel && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 4px', color: 'var(--text-tertiary)' }}>↵</span>}
            </div>
          );
        })}

        {actionMatches.length > 0 && <GroupLabel>Actions</GroupLabel>}
        {actionMatches.map((a) => {
          idx++;
          const i = idx;
          return (
            <div
              key={a.label}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                onAction(a.label);
                onClose();
              }}
              style={{ ...rowStyle(i), marginBottom: 8 }}
            >
              <Ic name={a.icon} size={14} color="var(--text-tertiary)" />
              {a.label}
            </div>
          );
        })}

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 36, padding: '0 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          <span><Key>↑↓</Key> navigate</span>
          <span><Key>↵</Key> open</span>
          <span><Key>esc</Key> close</span>
        </div>
      </div>
    </div>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <div style={{ padding: '8px 16px 4px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
      {children}
    </div>
  );
}
function Key({ children }: { children: string }) {
  return <span style={{ fontFamily: 'var(--font-mono)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '0 4px' }}>{children}</span>;
}
