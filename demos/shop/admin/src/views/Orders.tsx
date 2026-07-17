import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, kr, type OrderRow } from '../api';

const FILTERS = [
  { key: 'all', label: 'Alla' },
  { key: 'placed', label: 'Att plocka' },
  { key: 'fulfilled', label: 'Att avsluta' },
  { key: 'closed', label: 'Avslutade' },
] as const;

export function Orders({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');

  const load = useCallback(() => {
    setError(null);
    void api
      .orders()
      .then(setOrders)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const advance = async (o: OrderRow, kind: 'fulfil' | 'close') => {
    try {
      await (kind === 'fulfil' ? api.fulfil(o.id) : api.close(o.id));
      notify(kind === 'fulfil' ? `Order ${o.number} plockad` : `Order ${o.number} avslutad`, true);
      load();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  const shown = useMemo(
    () => (orders ?? []).filter((o) => (filter === 'all' ? true : o.status === filter)),
    [orders, filter],
  );

  if (error) return <div className="notice deny">{error}</div>;
  if (!orders) return <div className="notice">Laddar ordrar…</div>;

  return (
    <>
      <div className="sec-head">
        <div className="eyebrow">Lager &amp; expedition</div>
        <h1>Ordrar</h1>
      </div>

      <div className="panel actions" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`btn sm ${filter === f.key ? '' : 'ghost'}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key !== 'all' && ` (${orders.filter((o) => o.status === f.key).length})`}
          </button>
        ))}
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th className="num">Nr</th>
              <th className="l">Status</th>
              <th className="l">Betalning</th>
              <th className="l">Lagd</th>
              <th className="num">Summa</th>
              <th className="l">Åtgärd</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6}><div className="notice">Inga ordrar i det här läget.</div></td></tr>
            )}
            {shown.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => { location.hash = `#/orders/${o.id}`; }}>
                <td className="num">#{o.number}</td>
                <td><span className={`pill ${o.status}`}>{o.status}</span></td>
                <td>{o.payment_method === 'invoice' ? 'Mot faktura' : 'Kort'}</td>
                <td className="muted">{new Date(o.placed_at).toLocaleString('sv-SE')}</td>
                <td className="num">{kr(o.total_amount)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {o.status === 'placed' && (
                    <button className="btn sm" onClick={() => advance(o, 'fulfil')}>Plocka</button>
                  )}
                  {o.status === 'fulfilled' && (
                    <button className="btn sm ghost" onClick={() => advance(o, 'close')}>Avsluta</button>
                  )}
                  {(o.status === 'closed' || o.status === 'cancelled') && <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
