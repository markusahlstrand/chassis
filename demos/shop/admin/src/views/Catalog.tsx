import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, kr, type StockRow } from '../api';

/** One editable on-hand cell — a local draft until saved, so typing never races the reload. */
function StockCell({
  row,
  onSaved,
  notify,
}: {
  row: StockRow;
  onSaved: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [draft, setDraft] = useState(String(row.onHand));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(String(row.onHand)), [row.onHand]);

  const dirty = draft !== String(row.onHand);
  const save = async () => {
    const qty = Number(draft);
    if (!Number.isInteger(qty) || qty < 0) {
      notify('Saldo måste vara ett heltal ≥ 0');
      return;
    }
    setBusy(true);
    try {
      await api.setStock(row.variantId, qty);
      notify(`${row.sku}: saldo satt till ${qty}`, true);
      onSaved();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stock-edit">
      <input
        value={draft}
        inputMode="numeric"
        aria-label={`Saldo för ${row.sku}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
        }}
      />
      <button className="btn sm ghost" disabled={!dirty || busy} onClick={save}>
        Spara
      </button>
    </div>
  );
}

export function Catalog({
  notify,
  canManageCatalog,
}: {
  notify: (msg: string, ok?: boolean) => void;
  canManageCatalog: boolean;
}) {
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void api
      .stock()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  // Group the flat variant rows back into products for display.
  const products = useMemo(() => {
    const by = new Map<string, { name: string; slug: string; published: number; variants: StockRow[] }>();
    for (const r of rows ?? []) {
      const p = by.get(r.productId) ?? { name: r.productName, slug: r.slug, published: r.published, variants: [] };
      p.variants.push(r);
      by.set(r.productId, p);
    }
    return [...by.entries()];
  }, [rows]);

  const togglePublish = async (productId: string, name: string, published: boolean) => {
    try {
      await api.publishProduct(productId, published);
      notify(`${name} ${published ? 'publicerad' : 'avpublicerad'}`, true);
      load();
    } catch (e) {
      notify((e as Error).message);
    }
  };

  if (error) return <div className="notice deny">{error}</div>;
  if (!rows) return <div className="notice">Laddar lagersaldo…</div>;

  return (
    <>
      <div className="sec-head">
        <div className="eyebrow">Lager &amp; sortiment</div>
        <h1>Katalog</h1>
        <p>
          Saldo är det som står på hyllan. Reserverat är varukorgar som håller varan i 15 minuter —
          därför kan tillgängligt vara lägre än saldot utan att något är sålt. Kassan reserverar mot
          tillgängligt, aldrig mot saldot.
          {!canManageCatalog && ' Din roll kan justera saldo men inte publicera.'}
        </p>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th className="l">Artikel</th>
              <th className="l">Variant</th>
              <th className="num">Pris</th>
              <th className="num">Saldo</th>
              <th className="num">Reserverat</th>
              <th className="num">Tillgängligt</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 && (
              <tr><td colSpan={6}><div className="notice">Inga artiklar i katalogen.</div></td></tr>
            )}
            {products.map(([productId, p]) => (
              <Fragment key={productId}>
                <tr className="group-row">
                  <td colSpan={canManageCatalog ? 5 : 6}>
                    <strong>{p.name}</strong>
                    <span className="muted num" style={{ fontSize: 10.5, marginLeft: 8 }}>{p.slug}</span>
                    {!p.published && <span className="pill draft" style={{ marginLeft: 8 }}>utkast</span>}
                  </td>
                  {canManageCatalog && (
                    <td className="num">
                      <button className="btn sm ghost" onClick={() => togglePublish(productId, p.name, !p.published)}>
                        {p.published ? 'Avpublicera' : 'Publicera'}
                      </button>
                    </td>
                  )}
                </tr>
                {p.variants.map((v) => (
                  <tr key={v.variantId}>
                    <td className="muted num" style={{ fontSize: 10.5, paddingLeft: 30 }}>{v.sku}</td>
                    <td>{v.grind} · {v.sizeLabel}</td>
                    <td className="num">{kr(v.price.amount)}</td>
                    <td className="num"><StockCell row={v} onSaved={load} notify={notify} /></td>
                    <td className="num muted">{v.reserved > 0 ? v.reserved : '—'}</td>
                    <td className="num">
                      <span className={v.available <= 0 ? 'stock out' : v.available <= 8 ? 'stock low' : 'stock ok'}>
                        <span className="dot" />
                        {v.available}
                      </span>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
