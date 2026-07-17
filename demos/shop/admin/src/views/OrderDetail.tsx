import { useCallback, useEffect, useState } from 'react';
import { api, kr, type OrderLineRow, type OrderRow } from '../api';

const STEPS: OrderRow['status'][] = ['placed', 'fulfilled', 'closed'];
const STEP_LABEL: Record<string, string> = {
  placed: 'Lagd',
  fulfilled: 'Plockad',
  closed: 'Avslutad',
};

function StatusFlow({ status }: { status: OrderRow['status'] }) {
  if (status === 'cancelled') {
    return <div className="statusflow"><span className="step current">Annullerad</span></div>;
  }
  const idx = STEPS.indexOf(status);
  return (
    <div className="statusflow">
      {STEPS.map((s, i) => (
        <span key={s} style={{ display: 'contents' }}>
          {i > 0 && <span className="arrow">→</span>}
          <span className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>{STEP_LABEL[s]}</span>
        </span>
      ))}
    </div>
  );
}

export function OrderDetail({
  orderId,
  notify,
}: {
  orderId: string;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [lines, setLines] = useState<OrderLineRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void api
      .order(orderId)
      .then((d) => {
        setOrder(d.order);
        setLines(d.lines);
      })
      .catch((e: Error) => setError(e.message));
  }, [orderId]);
  useEffect(load, [load]);

  const advance = async (kind: 'fulfil' | 'close') => {
    try {
      const updated = await (kind === 'fulfil' ? api.fulfil(orderId) : api.close(orderId));
      notify(kind === 'fulfil' ? `Order ${updated.number} plockad` : `Order ${updated.number} avslutad`, true);
      load();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  if (error) return <div className="notice deny">{error}</div>;
  if (!order) return <div className="notice">Laddar order…</div>;

  return (
    <>
      <a href="#/orders" className="back">← Ordrar</a>
      <div className="sec-head">
        <div className="eyebrow">
          {order.payment_method === 'invoice' ? 'Mot faktura' : 'Kortbetalning'} ·{' '}
          {new Date(order.placed_at).toLocaleString('sv-SE')}
        </div>
        <div className="row-head">
          <h1>Order #{order.number}</h1>
          <span className={`pill ${order.status}`}>{order.status}</span>
        </div>
      </div>

      <StatusFlow status={order.status} />

      <div className="panel actions">
        {order.status === 'placed' && <button className="btn" onClick={() => advance('fulfil')}>Plocka ordern</button>}
        {order.status === 'fulfilled' && <button className="btn ghost" onClick={() => advance('close')}>Avsluta ordern</button>}
        {(order.status === 'closed' || order.status === 'cancelled') && (
          <span className="muted">
            Ordern är {order.status === 'closed' ? 'avslutad' : 'annullerad'} — inga fler steg.
          </span>
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <table>
          <thead>
            <tr>
              <th className="l">Artikel</th>
              <th className="l">Variant</th>
              <th className="num">Antal</th>
              <th className="num">À-pris</th>
              <th className="num">Summa</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.name}
                  <div className="muted num" style={{ fontSize: 10.5, marginTop: 2 }}>{l.sku}</div>
                </td>
                <td className="muted">{l.grind} · {l.size_label}</td>
                <td className="num">{l.qty}</td>
                <td className="num">{kr(l.unit_price_amount)}</td>
                <td className="num">{kr(l.line_total_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel pad" style={{ marginTop: 16 }}>
        <div className="totals">
          <div className="r">
            <span>Delsumma</span>
            <span>{kr(order.subtotal_amount)}</span>
          </div>
          {Number(order.discount_amount) > 0 && (
            <div className="r disc">
              <span>Rabatt {order.discount_code}</span>
              <span>−{kr(order.discount_amount)}</span>
            </div>
          )}
          <div className="r tot">
            <span>Totalt</span>
            <span>{kr(order.total_amount)}</span>
          </div>
        </div>
        <p className="note">
          Raderna snapshottades när ordern lades — priset i katalogen kan ändras utan att ordern rör sig.
        </p>
      </div>
    </>
  );
}
