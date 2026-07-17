import { useCallback, useEffect, useState } from 'react';
import { api, kr, type OrderRow, type StockRow } from '../api';

/**
 * The landing surface. Everything here is derived from the two reads the
 * back-office already makes — no new operation, no cross-module SQL.
 */
export function Overview() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void Promise.all([api.orders(), api.stock()])
      .then(([o, s]) => {
        setOrders(o);
        setStock(s);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (error) return <div className="notice deny">{error}</div>;
  if (!orders || !stock) return <div className="notice">Laddar översikt…</div>;

  const toPick = orders.filter((o) => o.status === 'placed');
  const toClose = orders.filter((o) => o.status === 'fulfilled');
  const outOfStock = stock.filter((s) => s.available <= 0);
  const heldUnits = stock.reduce((a, s) => a + s.reserved, 0);
  const openValue = [...toPick, ...toClose].reduce((a, o) => a + Number(o.total_amount), 0);
  const recent = orders.slice(0, 6);

  return (
    <>
      <div className="sec-head">
        <div className="eyebrow">Kallkälla Kaffe</div>
        <h1>Översikt</h1>
      </div>

      <div className="tiles">
        <div className={`tile${toPick.length > 0 ? ' warn' : ''}`}>
          <div className="k">Att plocka</div>
          <div className="v">{toPick.length}</div>
          <div className="sub">ordrar med status placed</div>
        </div>
        <div className="tile">
          <div className="k">Att avsluta</div>
          <div className="v">{toClose.length}</div>
          <div className="sub">plockade, ej avslutade</div>
        </div>
        <div className={`tile${outOfStock.length > 0 ? ' bad' : ''}`}>
          <div className="k">Slutsålda</div>
          <div className="v">{outOfStock.length}</div>
          <div className="sub">varianter utan tillgängligt saldo</div>
        </div>
        <div className="tile">
          <div className="k">Reserverat nu</div>
          <div className="v">{heldUnits}</div>
          <div className="sub">enheter i öppna varukorgar</div>
        </div>
      </div>

      <div className="panel pad">
        <div className="k eyebrow">Öppet ordervärde</div>
        <div className="num" style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
          {kr(String(openValue))}
        </div>
        <p className="note" style={{ margin: '6px 0 0' }}>
          Summan av ordrar som ännu inte är avslutade. Reserverade enheter är inte sålda — de
          släpps automatiskt när varukorgens hold på 15 minuter löper ut.
        </p>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr>
              <th className="num">Nr</th>
              <th className="l">Status</th>
              <th className="l">Betalning</th>
              <th className="l">Lagd</th>
              <th className="num">Summa</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={5}><div className="notice">Inga ordrar ännu.</div></td></tr>
            )}
            {recent.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => { location.hash = `#/orders/${o.id}`; }}>
                <td className="num">#{o.number}</td>
                <td><span className={`pill ${o.status}`}>{o.status}</span></td>
                <td>{o.payment_method === 'invoice' ? 'Mot faktura' : 'Kort'}</td>
                <td className="muted">{new Date(o.placed_at).toLocaleString('sv-SE')}</td>
                <td className="num">{kr(o.total_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
