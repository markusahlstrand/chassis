import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  api,
  dayLabel,
  hhmm,
  setPrincipal,
  type CastMember,
  type CourtListing,
  type Money,
  type Reservation,
  type SlotFit,
} from './api';

type Tab = 'book' | 'mine' | 'me';
const STORE = 'rally-player-principal';
const todayISO = () => new Date().toISOString().slice(0, 10);
const kr = (m: Money) => `${m.amount} kr`;

export default function App() {
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [memberIds, setMemberIds] = useState<Record<string, string>>({});
  const [who, setWho] = useState(() => localStorage.getItem(STORE) ?? 'elin');
  const [tab, setTab] = useState<Tab>('book');
  const [tz, setTz] = useState('Europe/Stockholm');

  useEffect(() => {
    void api.cast().then((r) => {
      // Apply the principal BEFORE the state update that mounts the screens.
      // React runs child effects before parent effects, so a screen mounted in
      // this same commit would otherwise fire its first fetch with no
      // x-principal header and take a 403.
      const saved = localStorage.getItem(STORE) ?? 'elin';
      const start = r.cast[saved] ? saved : (Object.keys(r.cast)[0] ?? '');
      const p = r.cast[start]?.principal;
      if (p) setPrincipal(p);
      setCast(r.cast);
      setMemberIds(r.members);
      setWho(start);
      if (p) void api.venue().then((v) => setTz(v.venue.timezone)).catch(() => {});
    });
  }, []);

  const pick = useCallback(
    (key: string) => {
      const p = cast[key]?.principal;
      if (p) setPrincipal(p);
      localStorage.setItem(STORE, key);
      setWho(key);
      if (p) void api.venue().then((v) => setTz(v.venue.timezone)).catch(() => {});
    },
    [cast],
  );

  const memberId = memberIds[who] ?? '';
  const ready = Boolean(cast[who]);

  return (
    <div className="phone">
      <div className="topbar">
        <span className="brand-mark" />
        <span className="wordmark">RALLYPOINT</span>
        <select className="who" value={who} onChange={(e) => pick(e.target.value)}>
          {Object.entries(cast).map(([k, m]) => (
            <option key={k} value={k}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="scroll">
        {!ready && <div className="empty">Laddar…</div>}
        {ready && tab === 'book' && <Book tz={tz} memberId={memberId} />}
        {ready && tab === 'mine' && <Mine tz={tz} />}
        {ready && tab === 'me' && <Me who={cast[who]!} memberId={memberId} />}
      </div>

      <nav className="nav">
        {(
          [
            ['book', 'Boka'],
            ['mine', 'Mina tider'],
            ['me', 'Profil'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Book({ tz, memberId }: { tz: string; memberId: string }) {
  const [courts, setCourts] = useState<CourtListing[]>([]);
  const [courtId, setCourtId] = useState('');
  const [date, setDate] = useState(todayISO);
  const [slots, setSlots] = useState<SlotFit[]>([]);
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(90);
  const [held, setHeld] = useState<{ r: Reservation; price: Money; label: string } | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .courts()
      .then((c) => {
        setCourts(c);
        setCourtId((id) => id || (c[0]?.id ?? ''));
      })
      .catch((e) => setErr(e.message));
  }, []);

  const loadSlots = useCallback(() => {
    if (!courtId) return;
    void api
      .availability(courtId, date)
      .then((s) => setSlots(s))
      .catch((e) => setErr(e.message));
  }, [courtId, date]);
  useEffect(loadSlots, [loadSlots]);

  const court = courts.find((c) => c.id === courtId);
  const offered = (court?.durations ?? '60,90,120').split(',').map(Number);
  const chosen = slots.find((s) => hhmm(s.startsAt, tz) === start);
  const fits = chosen?.fits ?? [];

  // Every tap must lead somewhere: if the chosen duration stops fitting, fall
  // back to the longest that does rather than dead-ending on a disabled CTA.
  useEffect(() => {
    if (start && fits.length > 0 && !fits.includes(duration)) setDuration(fits[fits.length - 1]!);
  }, [start, fits, duration]);

  if (held) {
    return (
      <Pay
        tz={tz}
        held={held}
        onDone={() => {
          setHeld(null);
          setStart('');
          loadSlots();
        }}
      />
    );
  }

  const hold = async () => {
    if (!courtId || !memberId || !start) return;
    setBusy(true);
    setErr('');
    setTaken(null);
    try {
      const r = await api.book({ resourceId: courtId, memberId, date, time: start, duration });
      setHeld({ r: r.reservation, price: r.price, label: r.ruleLabel });
    } catch (e) {
      if (e instanceof ApiError && e.isSlotTaken) {
        setTaken(start);
        loadSlots();
      } else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const alternatives = slots.filter((s) => s.fits.includes(duration)).slice(0, 3);

  return (
    <>
      <h1>Boka bana</h1>

      {err && <div className="banner bad">{err}</div>}

      {taken && (
        <div className="banner">
          <strong>{taken} blev precis bokad.</strong>
          Inget är debiterat. Närmaste lediga tider:
          <div className="row" style={{ marginTop: 8 }}>
            {alternatives.map((a, i) => (
              <button
                key={a.startsAt}
                className={`pill ${i === 0 ? 'on' : ''}`}
                onClick={() => {
                  setStart(hhmm(a.startsAt, tz));
                  setTaken(null);
                }}
              >
                {hhmm(a.startsAt, tz)}
              </button>
            ))}
            {alternatives.length === 0 && <span className="meta">Inga kvar idag.</span>}
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 10 }}>
        {courts.map((c) => (
          <button
            key={c.id}
            className={`pill ${c.id === courtId ? 'on' : ''}`}
            onClick={() => {
              setCourtId(c.id);
              setStart('');
            }}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="card">
        <input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setStart('');
          }}
          style={{
            width: '100%',
            minHeight: 44,
            border: '1px solid var(--border-strong)',
            borderRadius: 12,
            padding: '0 10px',
            font: 'inherit',
          }}
        />
      </div>

      {slots.length === 0 && <div className="empty">Stängt eller fullbokat den här dagen.</div>}

      {slots.length > 0 && (
        <>
          <div className="slots">
            {slots.map((s) => {
              const t = hhmm(s.startsAt, tz);
              return (
                <button
                  key={s.startsAt}
                  className={`slot ${t === start ? 'on' : ''}`}
                  onClick={() => setStart(t)}
                >
                  <span className="t">{t}</span>
                  <span className="dots">
                    {[60, 90, 120].map((d) => (
                      <i key={d} className={s.fits.includes(d) ? 'on' : ''} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="legend">● 60 · ●● 90 · ●●● 120 min ryms</p>
        </>
      )}

      {start && (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Längd</h2>
          <div className="seg" style={{ marginTop: 8 }}>
            {offered.map((d) => {
              const ok = fits.includes(d);
              return (
                <button
                  key={d}
                  className={duration === d ? 'on' : ''}
                  disabled={!ok}
                  onClick={() => setDuration(d)}
                >
                  {d} min
                </button>
              );
            })}
          </div>
          {offered.some((d) => !fits.includes(d)) && (
            <p className="legend">
              Gråa längder ryms inte vid {start} — luckan tar slut innan dess.
            </p>
          )}
        </div>
      )}

      <button className="cta" disabled={busy || !start || !memberId} onClick={() => void hold()}>
        {start ? `Håll ${start} · ${duration} min →` : 'Välj en tid'}
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------

function Pay({
  tz,
  held,
  onDone,
}: {
  tz: string;
  held: { r: Reservation; price: Money; label: string };
  onDone: () => void;
}) {
  const [left, setLeft] = useState(() => secondsLeft(held.r));
  const [err, setErr] = useState('');
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setLeft(secondsLeft(held.r)), 1000);
    return () => clearInterval(t);
  }, [held.r]);

  const total = held.r.expiresAt
    ? Math.max(1, (Date.parse(held.r.expiresAt) - Date.parse(held.r.startsAt)) / 1000)
    : 600;
  const urgent = left > 0 && left < 60;

  if (paid) {
    return (
      <>
        <h1>Klart!</h1>
        <div className="card">
          <h2>Bokningen är bekräftad</h2>
          <p className="meta">
            {dayLabel(held.r.startsAt, tz)} · {hhmm(held.r.startsAt, tz)}–
            {hhmm(held.r.endsAt, tz)}
          </p>
        </div>
        <button className="cta" onClick={onDone}>
          Tillbaka
        </button>
      </>
    );
  }

  if (left <= 0) {
    return (
      <>
        <h1>Hållningen gick ut</h1>
        <div className="card">
          <div className="clock" style={{ color: 'var(--muted-2)' }}>
            0:00
          </div>
          <p className="meta" style={{ marginTop: 6 }}>
            Ingenting har debiterats. Tiden kan fortfarande vara ledig — försök igen.
          </p>
        </div>
        <button className="cta" onClick={onDone}>
          Se andra tider
        </button>
      </>
    );
  }

  return (
    <>
      <h1>Bekräfta</h1>
      <div className={`hold ${urgent ? 'urgent' : ''}`}>
        <div className="lbl">Banan är reserverad åt dig</div>
        <div className="clock">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </div>
        <div className="bar">
          <i style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
        </div>
      </div>

      <div className="card">
        <h2>{dayLabel(held.r.startsAt, tz)}</h2>
        <p className="meta mono" style={{ fontSize: 13 }}>
          {hhmm(held.r.startsAt, tz)}–{hhmm(held.r.endsAt, tz)}
        </p>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          <span className="meta">{held.label}</span>
          <span className="mono" style={{ fontSize: 16, color: 'var(--ink)', fontWeight: 600 }}>
            {kr(held.price)}
          </span>
        </div>
      </div>

      {err && <div className="banner bad">{err}</div>}

      <button
        className="cta"
        onClick={() => {
          setErr('');
          api
            .confirm(held.r.id)
            .then(() => setPaid(true))
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
        }}
      >
        Betala {kr(held.price)}
      </button>
      <button className="cta ghost" style={{ marginTop: 8 }} onClick={onDone}>
        Avbryt
      </button>
    </>
  );
}

const secondsLeft = (r: Reservation): number =>
  r.expiresAt ? Math.max(0, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000)) : 0;

// ---------------------------------------------------------------------------

function Mine({ tz }: { tz: string }) {
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api
      .myBookings()
      .then(setRows)
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);

  const live = useMemo(
    () =>
      (rows ?? []).filter(
        (r) => r.effectiveState === 'held' || r.effectiveState === 'confirmed',
      ),
    [rows],
  );
  const past = useMemo(
    () => (rows ?? []).filter((r) => !live.includes(r)),
    [rows, live],
  );

  return (
    <>
      <h1>Mina tider</h1>
      {err && <div className="banner bad">{err}</div>}
      {rows === null && <div className="empty">Laddar…</div>}
      {rows !== null && live.length === 0 && (
        <div className="empty">Inga kommande bokningar.</div>
      )}

      {live.map((r) => (
        <div className="card" key={r.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h2>{dayLabel(r.startsAt, tz)}</h2>
            {r.effectiveState === 'held' ? (
              <span className="pill amber">HÅLLEN</span>
            ) : (
              <span className="pill green">BOKAD ✓</span>
            )}
          </div>
          <p className="meta mono" style={{ fontSize: 13 }}>
            {hhmm(r.startsAt, tz)}–{hhmm(r.endsAt, tz)}
          </p>
          <button
            className="cta ghost"
            style={{ marginTop: 10 }}
            onClick={() => {
              void api.cancel(r.id).then(load).catch((e) => setErr(e.message));
            }}
          >
            Avboka
          </button>
        </div>
      ))}

      {past.length > 0 && (
        <>
          <h2 style={{ marginTop: 18, marginBottom: 8 }}>Tidigare</h2>
          {past.map((r) => (
            <div className="card" key={r.id} style={{ opacity: 0.7 }}>
              <p className="meta mono">
                {dayLabel(r.startsAt, tz)} · {hhmm(r.startsAt, tz)} — {r.effectiveState}
              </p>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function Me({ who, memberId }: { who: CastMember; memberId: string }) {
  return (
    <>
      <h1>Profil</h1>
      <div className="card">
        <h2>{who.name}</h2>
        <p className="meta">Roll i demot: {who.role}</p>
        <p className="meta mono" style={{ marginTop: 8, wordBreak: 'break-all' }}>
          {memberId || '— ingen medlemspost —'}
        </p>
      </div>
      <div className="card">
        <p className="meta">
          Den här spelaren har <strong>ingen roll</strong> i klubben. Att se lediga tider och ta en
          ledig bana är scope-breda rättigheter; att läsa en bokning är smalnat till den egna
          medlemsposten.
        </p>
      </div>
    </>
  );
}
