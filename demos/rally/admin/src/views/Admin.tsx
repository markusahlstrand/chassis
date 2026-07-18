import { useCallback, useEffect, useState } from 'react';
import {
  api,
  newPartyRef,
  type Court,
  type Member,
  type VenueSnapshot,
} from '../api';

const DAYS = ['Sön', 'Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör'];
// Monday-first display over a Sunday-indexed store.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function Admin({ view }: { view: 'courts' | 'pricing' | 'members' | 'settings' }) {
  const [venue, setVenue] = useState<VenueSnapshot | null>(null);
  const [courts, setCourts] = useState<Court[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [err, setErr] = useState('');

  const reload = useCallback(async () => {
    setErr('');
    try {
      const [v, c] = await Promise.all([api.venue(), api.courts()]);
      setVenue(v);
      setCourts(c);
      try {
        setMembers(await api.members());
      } catch {
        setMembers([]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const guard = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {err && <div className="banner">{err}</div>}

      {view === 'courts' && (
        <div className="card">
          <h2>Banor</h2>
          <table>
            <thead>
              <tr>
                <th>Bana</th>
                <th>Längder</th>
                <th>Typ</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {courts.map((c) => {
                const cfg = venue?.courts.find((x) => x.resource_id === c.id);
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{c.name}</td>
                    <td className="mono">{cfg?.durations ?? '—'}</td>
                    <td>{cfg?.indoor ? 'inomhus' : 'utomhus'}</td>
                    <td>
                      {c.active ? (
                        <span className="chip green">aktiv</span>
                      ) : (
                        <span className="chip">⊘ inaktiv</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn"
                        onClick={() => void guard(() => api.setCourtActive(c.id, !c.active))}
                      >
                        {c.active ? 'Inaktivera' : 'Aktivera'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 10 }}>
            Tar du bort en längd döljs den i spelarappen för just den banan.
          </p>
          <NewCourt onCreate={(name, durations) => guard(() => api.addCourt({ name, durations }))} />
        </div>
      )}

      {view === 'pricing' && (
        <>
          <div className="card">
            <h2>Prisregler</h2>
            <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
              Mest specifik vinner: bana &gt; längd &gt; tid &gt; veckodag &gt; bas.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Regel</th>
                  <th>Tid</th>
                  <th>Längd</th>
                  <th style={{ textAlign: 'right' }}>Pris</th>
                </tr>
              </thead>
              <tbody>
                {venue?.priceRules.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{r.label}</td>
                    <td className="mono">
                      {r.from_time ? `${r.from_time}–${r.to_time}` : 'hela dagen'}
                    </td>
                    <td className="mono">{r.duration ?? 'alla'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {r.amount} kr
                    </td>
                  </tr>
                ))}
                {venue?.priceRules.length === 0 && (
                  <tr>
                    <td colSpan={4} className="hint">
                      Inga regler — bokning kommer att avvisas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>Medlemsnivåer</h3>
            <table>
              <thead>
                <tr>
                  <th>Nivå</th>
                  <th>Rabatt</th>
                  <th style={{ textAlign: 'right' }}>Avgift/mån</th>
                </tr>
              </thead>
              <tbody>
                {venue?.tiers.map((t) => (
                  <tr key={t.key}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{t.title}</td>
                    <td className="mono">−{t.discount_pct}%</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {t.monthly_amount} kr
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'members' && (
        <div className="card">
          <h2>Medlemmar</h2>
          {members.length === 0 && (
            <p className="hint">
              Ingen behörighet att läsa medlemsregistret med den valda rollen.
            </p>
          )}
          {members.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Namn</th>
                  <th>Nivå</th>
                  <th>Rating</th>
                  <th>Spelar-ID</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{m.name}</td>
                    <td>
                      <span className="chip">{m.tier}</span>
                    </td>
                    <td className="mono">{m.level ?? '—'}</td>
                    <td className="mono hint">{m.party_ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <NewMember
            onCreate={(name, tier) =>
              guard(() => api.addMember({ partyRef: newPartyRef(), name, tier }))
            }
          />
        </div>
      )}

      {view === 'settings' && (
        <>
          <div className="card">
            <h2>Öppettider</h2>
            <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
              Tider är lokal väggklocka i {venue?.venue.timezone}. Banornas egna tider kan bara
              smalna av klubbens, aldrig vidga dem.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Dag</th>
                  <th>Öppnar</th>
                  <th>Stänger</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ORDER.map((wd) => {
                  const h = venue?.hours.find((x) => x.weekday === wd);
                  return (
                    <tr key={wd}>
                      <td style={{ fontWeight: 700, color: 'var(--ink)' }}>{DAYS[wd]}</td>
                      <td className="mono">{h?.closed ? '—' : (h?.opens_at ?? '—')}</td>
                      <td className="mono">{h?.closed ? '—' : (h?.closes_at ?? '—')}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn"
                          onClick={() =>
                            void guard(() =>
                              api.setHours({ weekday: wd, closed: !h?.closed, opensAt: h?.opens_at ?? '08:00', closesAt: h?.closes_at ?? '22:00' }),
                            )
                          }
                        >
                          {h?.closed ? 'Öppna' : 'Stäng dagen'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Avvikelser</h3>
            {venue?.closures.length === 0 && <p className="hint">Inga registrerade.</p>}
            <table>
              <tbody>
                {venue?.closures.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.on_date}</td>
                    <td>{c.reason}</td>
                    <td>
                      {c.opens_at ? (
                        <span className="chip gold">
                          BLOCKERAD {c.opens_at}–{c.closes_at}
                        </span>
                      ) : (
                        <span className="chip amber">STÄNGT HELA DAGEN</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <NewClosure
              onCreate={(onDate, reason) => guard(() => api.addClosure({ onDate, reason }))}
            />
            <p className="hint" style={{ marginTop: 8 }}>
              En avvikelse gråar kalendern automatiskt. Redan lagda bokningar den dagen ligger kvar
              och måste flyttas för hand.
            </p>
          </div>
        </>
      )}
    </>
  );
}

function NewCourt({ onCreate }: { onCreate: (n: string, d: string) => void }) {
  const [name, setName] = useState('');
  const [durations, setDurations] = useState('60,90,120');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input type="text" placeholder="Bana 3" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="text" value={durations} onChange={(e) => setDurations(e.target.value)} />
      <button className="btn lime" disabled={!name} onClick={() => { onCreate(name, durations); setName(''); }}>
        Lägg till bana
      </button>
    </div>
  );
}

function NewMember({ onCreate }: { onCreate: (n: string, t: string) => void }) {
  const [name, setName] = useState('');
  const [tier, setTier] = useState('drop-in');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input type="text" placeholder="Namn" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={tier} onChange={(e) => setTier(e.target.value)}>
        <option value="drop-in">drop-in</option>
        <option value="member">member</option>
        <option value="club-plus">club-plus</option>
      </select>
      <button className="btn lime" disabled={!name} onClick={() => { onCreate(name, tier); setName(''); }}>
        Lägg till medlem
      </button>
    </div>
  );
}

function NewClosure({ onCreate }: { onCreate: (d: string, r: string) => void }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input type="text" placeholder="Orsak" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn" disabled={!date || !reason} onClick={() => { onCreate(date, reason); setDate(''); setReason(''); }}>
        Lägg till avvikelse
      </button>
    </div>
  );
}
