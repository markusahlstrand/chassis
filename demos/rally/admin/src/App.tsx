import { useCallback, useEffect, useState } from 'react';
import { api, setPrincipal, setVenue, type CastMember, type Venue } from './api';
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
  const [venues, setVenues] = useState<Venue[]>([]);
  const [allMembers, setAllMembers] = useState<Record<string, Record<string, string>>>({});
  const [venue, setVenueState] = useState<string>(
    () => localStorage.getItem(`${STORE}-venue`) ?? 'solna',
  );
  const [who, setWho] = useState<string>(() => localStorage.getItem(STORE) ?? 'astrid');
  const [view, setView] = useState<View>('calendar');
  const [date, setDate] = useState(todayISO);
  const [newBooking, setNewBooking] = useState(0); // bumped to open the drawer

  useEffect(() => {
    void api.cast().then((r) => {
      // Apply the principal BEFORE the state update that mounts the views.
      // React runs child effects before parent effects, so a view mounted in
      // this same commit would otherwise fire its first fetch with no
      // x-principal header and take a 403.
      const saved = localStorage.getItem(STORE) ?? 'astrid';
      const start = r.cast[saved] ? saved : (Object.keys(r.cast)[0] ?? '');
      const p = r.cast[start]?.principal;
      if (p) setPrincipal(p);
      setVenue(localStorage.getItem(`${STORE}-venue`) ?? 'solna');
      setCast(r.cast);
      setVenues(r.venues);
      setAllMembers(r.members);
      setWho(start);
    });
  }, []);

  // Same synchronous-before-render discipline as the principal picker.
  const pickVenue = useCallback((key: string) => {
    setVenue(key);
    localStorage.setItem(`${STORE}-venue`, key);
    setVenueState(key);
  }, []);

  // Switching principal is likewise applied synchronously, before the re-render
  // that makes the views refetch.
  const pick = useCallback(
    (key: string) => {
      const p = cast[key]?.principal;
      if (p) setPrincipal(p);
      localStorage.setItem(STORE, key);
      setWho(key);
    },
    [cast],
  );

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
          <label style={{ marginBottom: 4 }}>Klubb</label>
          <select
            value={venue}
            onChange={(e) => pickVenue(e.target.value)}
            style={{ width: '100%', fontSize: 11.5 }}
          >
            {venues.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
          <span className="mono" style={{ fontSize: 10, display: 'block', marginTop: 6 }}>
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

          <select value={who} onChange={(e) => pick(e.target.value)} title="Dev principal">
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
            <Calendar
              key={venue} /* switching club remounts: a new scope, a new world */
              date={date}
              openDrawer={newBooking}
              memberIds={allMembers[venue] ?? {}}
            />
          )}
          {ready && view !== 'calendar' && <Admin key={venue} view={view} />}
        </div>
      </main>
    </div>
  );
}
