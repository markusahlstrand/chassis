import { useCallback, useEffect, useState } from 'react';
import { api, kr, type OrderRow } from '../api';

export function Orders({ notify }: { notify: (msg: string, ok?: boolean) => void }) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <div className="wrap page"><div className="notice deny">{error}</div></div>;
  if (!orders) return <div className="wrap page"><div className="notice">Laddar ordrar…</div></div>;

  return (
    <div className="wrap page">
      <div className="sec-head">
        <div className="eyebrow">Lager &amp; expedition</div>
        <h1>Orderbok</h1>
      </div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th className="num">Nr</th>
              <th>Status</th>
              <th>Betalning</th>
              <th className="num">Summa</th>
              <th>Åtgärd</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 && (
              <tr><td colSpan={5}><div className="notice">Inga ordrar ännu.</div></td></tr>
            )}
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="num">#{o.number}</td>
                <td><span className={`pill ${o.status}`}>{o.status}</span></td>
                <td>{o.payment_method === 'invoice' ? 'Mot faktura' : 'Kort'}</td>
                <td className="num">{kr(o.total_amount)}</td>
                <td>
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
    </div>
  );
}
