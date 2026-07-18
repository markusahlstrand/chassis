import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  api,
  dayLabel,
  getVenue,
  hhmm,
  setPrincipal,
  setVenue,
  type CastMember,
  type Venue,
  COVER_SV,
  type Club,
  type Cover,
  type MatchLanding,
  type PlayedWith,
  type RosterEntry,
  type VenueSlot,
  type Money,
  type OpenMatch,
  type Reservation,
} from './api';

type Tab = 'book' | 'matches' | 'mine' | 'me';
const STORE = 'rally-player-principal';
const todayISO = () => new Date().toISOString().slice(0, 10);
const kr = (m: Money) => `${m.amount} kr`;

/**
 * A shared match link. It MUST carry the venue: a reservation id alone cannot be
 * resolved, because each club is its own scope and nothing indexes across them.
 * Older links without a venue fall back to the saved one, which is right often
 * enough for a demo and wrong in general — a real link would carry a token that
 * encodes the club.
 */
const linkParams = (): { match: string | null; venue: string | null } => {
  const q = new URLSearchParams(location.search);
  return { match: q.get('match'), venue: q.get('venue') };
};
export const matchLink = (venue: string, id: string): string =>
  `${location.origin}/?venue=${venue}&match=${id}`;

export default function App() {
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [venues, setVenues] = useState<Venue[]>([]);
  const [allMembers, setAllMembers] = useState<Record<string, Record<string, string>>>({});
  const [venue, setVenueState] = useState(
    () => localStorage.getItem(`${STORE}-venue`) ?? 'solna',
  );
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
      // A link's venue wins over the remembered one — you are being sent
      // somewhere specific.
      const fromLink = linkParams().venue;
      const v = fromLink ?? localStorage.getItem(`${STORE}-venue`) ?? 'solna';
      setVenue(v);
      setVenueState(v);
      setCast(r.cast);
      setVenues(r.venues);
      setAllMembers(r.members);
      setWho(start);
      if (p) void api.venue().then((v) => setTz(v.venue.timezone)).catch(() => {});
    });
  }, []);

  const pickVenue = useCallback((key: string) => {
    setVenue(key);
    localStorage.setItem(`${STORE}-venue`, key);
    setVenueState(key);
    void api.venue().then((v) => setTz(v.venue.timezone)).catch(() => {});
  }, []);

  const pickWho = useCallback(
    (key: string) => {
      const p = cast[key]?.principal;
      if (p) setPrincipal(p);
      localStorage.setItem(STORE, key);
      setWho(key);
      if (p) void api.venue().then((v) => setTz(v.venue.timezone)).catch(() => {});
    },
    [cast],
  );
  const pick = pickWho;

  // A member record is per club — the same human, a different row in each.
  const memberId = allMembers[venue]?.[who] ?? '';
  const ready = Boolean(cast[who]);
  const [invite, setInvite] = useState<string | null>(() => linkParams().match);

  // An invite takes over the whole screen: someone sent you here for one reason.
  if (invite) {
    return (
      <div className="phone">
        <JoinByLink
          reservationId={invite}
          tz={tz}
          memberId={memberId}
          ready={ready}
          who={who}
          cast={cast}
          onPick={pickWho}
          onDone={() => {
            history.replaceState({}, '', location.pathname);
            setInvite(null);
            setTab('mine');
          }}
        />
      </div>
    );
  }

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

      {venues.length > 1 && (
        <div className="row" style={{ padding: '0 16px 8px' }}>
          {venues.map((v) => (
            <button
              key={v.key}
              className={`pill ${v.key === venue ? 'on' : ''}`}
              onClick={() => pickVenue(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      <div className="scroll">
        {!ready && <div className="empty">Laddar…</div>}
        {ready && !memberId && (
          <div className="empty">
            Du är inte medlem i den här klubben.
            <br />
            Att gå med är en tilldelning per klubb — inte en global flagga.
          </div>
        )}
        {ready && memberId && tab === 'book' && <Book key={venue} tz={tz} memberId={memberId} />}
        {ready && memberId && tab === 'matches' && (
          <Matches key={venue} tz={tz} memberId={memberId} />
        )}
        {ready && memberId && tab === 'mine' && <Mine key={venue} tz={tz} />}
        {ready && tab === 'me' && <Me who={cast[who]!} memberId={memberId} />}
      </div>

      <nav className="nav" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {(
          [
            ['book', 'Boka'],
            ['matches', 'Matcher'],
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
  const [date, setDate] = useState(todayISO);
  const [cover, setCover] = useState<Cover[]>([]);
  const [slots, setSlots] = useState<VenueSlot[]>([]);
  const [start, setStart] = useState('');
  const [held, setHeld] = useState<{ r: Reservation; price: Money; label: string } | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Booking for yourself, or opening the court up for others to join.
  const [mode, setMode] = useState<'solo' | 'match'>('solo');
  const [fillTarget, setFillTarget] = useState(4);
  const [band, setBand] = useState<[string, string]>(['3.0', '4.5']);
  const [made, setMade] = useState<{ id: string; share: Money } | null>(null);

  const loadSlots = useCallback(() => {
    void api
      .venueAvailability(date, cover)
      .then((s) => setSlots(s))
      .catch((e) => setErr(e.message));
  }, [date, cover]);
  useEffect(loadSlots, [loadSlots]);

  const chosen = slots.find((s) => hhmm(s.startsAt, tz) === start);
  const fits = chosen?.fits ?? [];

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

  /**
   * One tap commits. Choosing a duration IS the decision — there is nothing left
   * to confirm on this screen, so a separate "hold the time" button was only ever
   * an extra tap between the player and the payment screen. The hold is safe to
   * take on a tap because it expires by itself and the next screen can cancel it.
   */
  const commit = async (time: string, minutes: number) => {
    if (!memberId) return;
    setBusy(true);
    setErr('');
    setTaken(null);
    try {
      if (mode === 'match') {
        const m = await api.createMatch({
          memberId, date, time, duration: minutes, cover,
          fillTarget, levelMin: band[0], levelMax: band[1],
        });
        setMade({ id: m.reservation.id, share: m.sharePerPlayer });
        loadSlots();
      } else {
        // No court: the vertical assigns one from the filtered pool (spec §4.2).
        const r = await api.book({ memberId, date, time, duration: minutes, cover });
        setHeld({ r: r.reservation, price: r.price, label: r.ruleLabel });
      }
    } catch (e) {
      if (e instanceof ApiError && e.isSlotTaken) {
        setTaken(time);
        loadSlots();
      } else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Tapping a time commits outright when only one duration can fit. */
  const pickTime = (time: string, slotFits: number[]) => {
    setStart(time);
    if (slotFits.length === 1) void commit(time, slotFits[0]!);
  };

  const alternatives = slots.slice(0, 3);
  void alternatives;

  return (
    <>
      <h1>{mode === 'match' ? 'Öppna en match' : 'Boka bana'}</h1>

      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={mode === 'solo' ? 'on' : ''} onClick={() => setMode('solo')}>
          Boka själv
        </button>
        <button className={mode === 'match' ? 'on' : ''} onClick={() => setMode('match')}>
          Öppen match
        </button>
      </div>

      {made && (
        <div className="banner">
          <strong>Matchen är öppen.</strong>
          Din andel är {made.share.amount} kr. Dela länken så fyller den sig själv.
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="pill on"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(matchLink(getVenue(), made.id))
                  .catch(() => {});
              }}
            >
              Kopiera länk
            </button>
            <button className="pill" onClick={() => setMade(null)}>
              Klart
            </button>
          </div>
        </div>
      )}

      {mode === 'match' && (
        <div className="card">
          <h2>Hur många platser öppnar du?</h2>
          {/* A padel match is four. The variable is how many places the host is
              opening — 1, 2 or 3 — so fillTarget is derived, never picked. */}
          <div className="seg" style={{ marginTop: 8 }}>
            {[1, 2, 3].map((spots) => (
              <button
                key={spots}
                className={fillTarget === spots + 1 ? 'on' : ''}
                onClick={() => setFillTarget(spots + 1)}
              >
                {spots} {spots === 1 ? 'plats' : 'platser'}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {(
              [
                ['Nybörjare', '1.0', '3.0'],
                ['Medel', '3.0', '4.5'],
                ['Avancerad', '4.5', '7.0'],
              ] as const
            ).map(([label, lo, hi]) => (
              <button
                key={label}
                className={`pill ${band[0] === lo ? 'on' : ''}`}
                onClick={() => setBand([lo, hi])}
              >
                {label} {lo}–{hi}
              </button>
            ))}
          </div>
          <p className="legend">
            Spelare utanför nivåspannet kan be om en plats. Din egen plats räknas när du öppnar
            matchen.
          </p>
        </div>
      )}

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

      {/* Filters narrow the pool BEFORE the time grid, never after. */}
      <div className="row" style={{ marginBottom: 10 }}>
        {(['indoor', 'covered', 'open'] as Cover[]).map((k) => (
          <button
            key={k}
            className={`pill ${cover.includes(k) ? 'on' : ''}`}
            onClick={() => {
              setCover((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
              setStart('');
            }}
          >
            {COVER_SV[k]}
          </button>
        ))}
        {cover.length > 0 && (
          <button className="pill" onClick={() => { setCover([]); setStart(''); }}>
            Rensa
          </button>
        )}
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
                  disabled={busy}
                  onClick={() => pickTime(t, s.fits)}
                >
                  <span className="t">{t}</span>
                  <span className="dots">
                    {[60, 90, 120].map((d) => (
                      <i key={d} className={s.fits.includes(d) ? 'on' : ''} />
                    ))}
                  </span>
                  <span className="legend" style={{ margin: 0, fontSize: 9 }}>
                    {s.courts.length} {s.courts.length === 1 ? 'bana' : 'banor'}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="legend">● 60 · ●● 90 · ●●● 120 min ryms</p>
        </>
      )}

      {/* Only asked when there is genuinely a choice — and answering it commits,
          so there is no trailing confirm button to tap. */}
      {start && fits.length > 1 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Hur länge, {start}?</h2>
          <div className="seg" style={{ marginTop: 8 }}>
            {fits.map((d) => (
              <button key={d} disabled={busy} onClick={() => void commit(start, d)}>
                {d} min
              </button>
            ))}
          </div>
          <p className="legend">
            Vi väljer bana åt dig — {chosen?.courts.length ?? 0} lediga vid {start}. Byt i nästa
            steg om du bryr dig.
          </p>
        </div>
      )}
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

function Matches({ tz, memberId }: { tz: string; memberId: string }) {
  const [rows, setRows] = useState<OpenMatch[] | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  // Default to every club the player can reach: an open match is worth finding
  // wherever it is, and the club is a filter rather than a precondition.
  const [allClubs, setAllClubs] = useState(true);

  const load = useCallback(() => {
    api
      .openMatches(allClubs)
      .then(setRows)
      .catch((e) => setErr(e.message));
  }, [allClubs]);
  useEffect(load, [load]);

  const join = (m: OpenMatch) => {
    setErr('');
    setOk('');
    api
      .joinMatch(m.reservationId, memberId)
      .then((r) => {
        setOk(`Du är med — din andel är ${r.share.amount} kr.`);
        load();
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  const share = async (m: OpenMatch) => {
    const url = matchLink(getVenue(), m.reservationId);
    try {
      await navigator.clipboard.writeText(url);
      setOk('Länk kopierad — klistra in i WhatsApp-gruppen.');
    } catch {
      setOk(url);
    }
  };

  return (
    <>
      <h1>Öppna matcher</h1>

      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={allClubs ? 'on' : ''} onClick={() => setAllClubs(true)}>
          Alla klubbar
        </button>
        <button className={!allClubs ? 'on' : ''} onClick={() => setAllClubs(false)}>
          Den här klubben
        </button>
      </div>

      {err && <div className="banner bad">{err}</div>}
      {ok && <div className="banner">{ok}</div>}
      {rows === null && <div className="empty">Laddar…</div>}
      {rows !== null && rows.length === 0 && (
        <div className="empty">
          Inga öppna matcher just nu.
          <br />
          Skapa en från en bokning så syns den här.
        </div>
      )}

      {(rows ?? []).map((m) => (
        <div className="card" key={m.reservationId}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <h2>{dayLabel(m.startsAt, tz)}</h2>
              <p className="meta mono" style={{ fontSize: 13 }}>
                {hhmm(m.startsAt, tz)}–{hhmm(m.endsAt, tz)} · {m.courtName}
              </p>
            </div>
            <span className="pill">
              {m.fillTarget - m.joined}{' '}
              {m.fillTarget - m.joined === 1 ? 'plats' : 'platser'} kvar
            </span>
          </div>
          {m.venueLabel && <p className="meta">{m.venueLabel}</p>}

          {/* Fill meter — momentum, not identities. Who is already in is a
              player-tier fact; the club scope reports counts only. */}
          <div className="row" style={{ gap: 4, marginTop: 10 }}>
            {Array.from({ length: m.fillTarget }, (_, i) => (
              <i
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 99,
                  background: i < m.joined ? 'var(--lime-deep)' : 'var(--alt-2)',
                }}
              />
            ))}
          </div>

          <Roster players={m.players} fillTarget={m.fillTarget} />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 10,
            }}
          >
            <span className="pill green">
              nivå {m.levelMin}–{m.levelMax}
            </span>
            <span className="mono" style={{ fontSize: 15, color: 'var(--ink)', fontWeight: 600 }}>
              {m.share.amount} kr
            </span>
          </div>

          <button className="cta" style={{ marginTop: 10 }} onClick={() => join(m)}>
            Gå med · {m.share.amount} kr
          </button>
          <button className="cta ghost" style={{ marginTop: 8 }} onClick={() => void share(m)}>
            Dela länk
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * The screen a shared link lands on. Per the handover (1m/2f): the match is
 * shown FIRST — you decide whether you care before you are asked who you are —
 * and a link that can no longer be taken says so plainly instead of failing.
 */
function JoinByLink({
  reservationId,
  tz,
  memberId,
  ready,
  who,
  cast,
  onPick,
  onDone,
}: {
  reservationId: string;
  tz: string;
  memberId: string;
  ready: boolean;
  who: string;
  cast: Record<string, CastMember>;
  onPick: (k: string) => void;
  onDone: () => void;
}) {
  // `null` from the API is mapped straight to 'missing', so it never lands here.
  const [m, setM] = useState<MatchLanding | 'loading' | 'missing'>('loading');
  const [err, setErr] = useState('');
  const [joined, setJoined] = useState<Money | null>(null);

  useEffect(() => {
    if (!ready) return;
    api
      .match(reservationId)
      .then((r) => setM(r ?? 'missing'))
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e));
        setM('missing');
      });
  }, [reservationId, ready]);

  const shell = (body: React.ReactNode) => (
    <div className="scroll" style={{ background: 'var(--ink)', minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 20px' }}>
        <span className="brand-mark" />
        <span className="wordmark" style={{ color: '#fff' }}>
          RALLYPOINT
        </span>
      </div>
      {body}
      <button
        className="cta ghost"
        style={{ marginTop: 12, background: 'transparent', color: '#fff', borderColor: '#4a5050' }}
        onClick={onDone}
      >
        Bara nyfiken? Titta på klubben →
      </button>
    </div>
  );

  if (m === 'loading') return shell(<p style={{ color: '#8A938C' }}>Laddar inbjudan…</p>);

  if (m === 'missing')
    return shell(
      <div className="card">
        <h2>Matchen finns inte</h2>
        <p className="meta">Länken kan höra till en annan klubb. {err}</p>
      </div>,
    );

  if (joined)
    return shell(
      <div className="card">
        <h2>Du är med!</h2>
        <p className="meta">Din andel är {joined.amount} kr. Matchen syns under Mina tider.</p>
      </div>,
    );

  const dead = m.status !== 'open';
  return shell(
    <>
      <p style={{ color: '#D7F34F', fontWeight: 700, marginTop: 0 }}>
        Du är inbjuden till en match
      </p>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <h2>{dayLabel(m.startsAt, tz)}</h2>
            <p className="meta mono" style={{ fontSize: 15 }}>
              {hhmm(m.startsAt, tz)}–{hhmm(m.endsAt, tz)}
            </p>
            <p className="meta">
              {m.venueName} · {m.courtName}
            </p>
          </div>
          <span className={`pill ${m.status === 'full' ? 'amber' : ''}`}>
            {m.joined}/{m.fillTarget}
          </span>
        </div>
        <Roster players={m.players} fillTarget={m.fillTarget} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 12,
          }}
        >
          <span className="pill green">
            nivå {m.levelMin}–{m.levelMax}
          </span>
          <span className="mono" style={{ fontSize: 16, color: 'var(--ink)', fontWeight: 600 }}>
            din andel {m.share.amount} kr
          </span>
        </div>
      </div>

      {m.status === 'full' && (
        <div className="banner">
          <strong>Matchen blev full.</strong>
          Ingenting har debiterats. Titta på klubbens övriga tider i stället.
        </div>
      )}
      {m.status === 'expired' && (
        <div className="banner">
          <strong>Länken har gått ut.</strong>
          Matchen har redan börjat — länkar dör vid starttid.
        </div>
      )}
      {m.status === 'gone' && (
        <div className="banner bad">
          <strong>Matchen är avbokad.</strong>
        </div>
      )}
      {err && <div className="banner bad">{err}</div>}

      {!dead && (
        <>
          {/* Stands in for sign-in: you are asked who you are only once you have
              seen what you are being asked to join. */}
          <div className="card">
            <h2>Vem är du?</h2>
            <select
              className="who"
              style={{ width: '100%', marginTop: 8, marginLeft: 0 }}
              value={who}
              onChange={(e) => onPick(e.target.value)}
            >
              {Object.entries(cast).map(([k, c]) => (
                <option key={k} value={k}>
                  {c.name}
                </option>
              ))}
            </select>
            {!memberId && (
              <p className="legend">Du är inte medlem i {m.venueName} — välj någon annan.</p>
            )}
          </div>

          <button
            className="cta"
            disabled={!memberId}
            onClick={() => {
              setErr('');
              api
                .joinMatch(m.reservationId, memberId)
                .then((r) => setJoined(r.share))
                .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
            }}
          >
            Ta platsen · {m.share.amount} kr
          </button>
        </>
      )}
    </>,
  );
}

/**
 * Who is on a match, by name. The club's roster is shut to players — but a
 * published match is the deliberate exception (spec §4.4): nobody commits 90
 * minutes and a payment to three anonymous slots.
 */
function Roster({ players, fillTarget }: { players: RosterEntry[]; fillTarget: number }) {
  const empty = Math.max(0, fillTarget - players.length);
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
      {players.map((p) => (
        <div key={p.partyRef} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 26, height: 26, borderRadius: 99, background: 'var(--lime)',
              border: '1.5px solid var(--ink)', display: 'grid', placeItems: 'center',
              fontSize: 11, fontWeight: 700, color: 'var(--ink)',
            }}
          >
            {p.name.slice(0, 1)}
          </span>
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.name}</span>
          {p.level && <span className="pill mono" style={{ marginLeft: 'auto' }}>{p.level}</span>}
        </div>
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.55 }}>
          <span
            style={{
              width: 26, height: 26, borderRadius: 99,
              border: '1.5px dashed var(--border-strong)',
            }}
          />
          <span className="meta">Ledig plats</span>
        </div>
      ))}
    </div>
  );
}

function Me({ who, memberId }: { who: CastMember; memberId: string }) {
  const [people, setPeople] = useState<PlayedWith[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);

  useEffect(() => {
    if (memberId) api.playedWith(memberId).then(setPeople).catch(() => setPeople([]));
    api.clubs().then(setClubs).catch(() => setClubs([]));
  }, [memberId]);

  return (
    <>
      <h1>Profil</h1>
      <div className="card">
        <h2>{who.name}</h2>
        <p className="meta">Roll i demot: {who.role}</p>
      </div>

      <div className="card">
        <h2>Spelare du mött</h2>
        {people.length === 0 && (
          <p className="meta">
            Ingen än. Personer dyker upp här automatiskt när ni spelat ihop — det finns ingen
            spelarsökning.
          </p>
        )}
        {people.map((p) => (
          <div
            key={p.name}
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
          >
            <span
              style={{
                width: 30, height: 30, borderRadius: 99, background: 'var(--lime)',
                border: '1.5px solid var(--ink)', display: 'grid', placeItems: 'center',
                fontWeight: 700, color: 'var(--ink)',
              }}
            >
              {p.name.slice(0, 1)}
            </span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--ink)' }}>{p.name}</div>
              <div className="meta">spelat ihop ×{p.times}</div>
            </div>
            {p.level && <span className="pill mono" style={{ marginLeft: 'auto' }}>{p.level}</span>}
          </div>
        ))}
        <p className="legend" style={{ marginTop: 10 }}>
          Bara den här klubben. Listan över alla du spelat med, oavsett klubb, hör hemma i
          spelarlagret — en klubbs databas kan inte svara på den frågan.
        </p>
      </div>

      <div className="card">
        <h2>Klubbar</h2>
        {clubs.map((c) => (
          <div
            key={c.key}
            style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}
          >
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.label}</span>
            <span className="meta mono">{c.slug}</span>
          </div>
        ))}
        <p className="legend" style={{ marginTop: 10 }}>
          Alla klubbar, från katalogen — även de du inte gått med i. Vad du får göra i dem är en
          annan fråga. En karta kräver koordinater, som hör hemma på katalogposten.
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
