import { useCallback, useEffect, useState } from 'react';
import { api, setPrincipal, type CastMember } from './api';
import Calendar from './views/Calendar';
import Admin from './views/Admin';

type View = 'calendar' | 'courts' | 'pricing' | 'members' | 'settings';

const NAV: { key: View; label: string }[] = [
  { key: 'calendar', label: 'Kalender' },
  { key: 'courts', label: 'Banor' },
  { key: 'pricing', label: 'Priser' },
  { key: 'members', label: 'Medlemmar' },
  { key: 'settings', label: 'Inställningar' },
];

// Vertical-specific key so the demos can coexist in one browser profile.
const STORE = 'rally-console-principal';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

export default function App() {
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [memberIds, setMemberIds] = useState<Record<string, string>>({});
  const [who, setWho] = useState<string>(() => localStorage.getItem(STORE) ?? 'astrid');
  const [view, setView] = useState<View>('calendar');
  const [date, setDate] = useState(todayISO);
  const [newBooking, setNewBooking] = useState(0); // bumped to open the drawer

  useEffect(() => {
    void api.cast().then((r) => {
      setCast(r.cast);
      setMemberIds(r.members);
    });
  }, []);

  useEffect(() => {
    const p = cast[who]?.principal;
    if (p) setPrincipal(p);
    localStorage.setItem(STORE, who);
  }, [cast, who]);

  const shiftDay = useCallback((delta: number) => {
    setDate((d) => {
      const next = new Date(`${d}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + delta);
      return next.toISOString().slice(0, 10);
    });
  }, []);

  // Keyboard-first, per the handover: N new booking, T today, ←/→ day pager.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
      if (e.key === 'n' || e.key === 'N') setNewBooking((n) => n + 1);
      if (e.key === 't' || e.key === 'T') setDate(todayISO());
      if (e.key === 'ArrowLeft') shiftDay(-1);
      if (e.key === 'ArrowRight') shiftDay(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shiftDay]);

  const ready = Boolean(cast[who]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          <span className="wordmark">RALLYPOINT</span>
          <span className="tag">MGR</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'on' : ''}
              onClick={() => setView(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          RallyPoint Solna
          <br />
          <span className="mono" style={{ fontSize: 10 }}>
            {cast[who]?.role ?? '—'}
          </span>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="btn" onClick={() => shiftDay(-1)} title="Föregående dag">
            ‹
          </button>
          <button className="btn" onClick={() => setDate(todayISO())}>
            Idag<span className="kbd">T</span>
          </button>
          <button className="btn" onClick={() => shiftDay(1)} title="Nästa dag">
            ›
          </button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <span className="spacer" />

          <select value={who} onChange={(e) => setWho(e.target.value)} title="Dev principal">
            {Object.entries(cast).map(([k, m]) => (
              <option key={k} value={k}>
                {m.name}
              </option>
            ))}
          </select>
          <button className="btn lime" onClick={() => setNewBooking((n) => n + 1)}>
            + Ny bokning<span className="kbd">N</span>
          </button>
        </div>

        <div className="content">
          {!ready && <div className="card">Laddar…</div>}
          {ready && view === 'calendar' && (
            <Calendar date={date} openDrawer={newBooking} memberIds={memberIds} />
          )}
          {ready && view !== 'calendar' && <Admin view={view} />}
        </div>
      </main>
    </div>
  );
}
