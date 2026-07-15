import { useEffect, useState } from 'react';
import { api, kr, type CatalogProduct } from '../api';
import { Bag, RoastDots, StockChip, cheapestVariant } from '../components';

export function Storefront({
  onAdd,
  reloadKey,
}: {
  onAdd: (variantId: string) => void;
  reloadKey: number;
}) {
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void api
      .catalog()
      .then(setProducts)
      .catch((e: Error) => setError(e.message));
  }, [reloadKey]);

  if (error) return <div className="notice deny">{error}</div>;
  if (!products) return <div className="notice">Laddar sortiment…</div>;

  return (
    <div className="wrap page">
      <div className="sec-head">
        <div className="eyebrow">Rostat i veckan</div>
        <h1>Vårt kaffe just nu</h1>
        <p>Småskaligt rostat i Stockholm. Begränsade partier — när en lot är slut är den slut.</p>
      </div>
      <div className="grid">
        {products.map((p) => {
          const v = cheapestVariant(p.variants);
          const available = v?.available ?? 0;
          const sold = available <= 0;
          return (
            <div className={`card${sold ? ' sold' : ''}`} key={p.id}>
              <div className="c-top">
                <div>
                  <div className="c-name">{p.name}</div>
                  <div className="c-origin">{p.origin}</div>
                </div>
                <RoastDots level={p.roast} />
              </div>
              <Bag name={p.name} origin={p.origin} roast={p.roast} slug={p.slug} />
              <div className="c-notes">{p.notes}</div>
              <StockChip available={available} />
              <div className="c-foot">
                <div className="c-price num">
                  {v ? kr(v.price.amount) : '—'} <small>/ {v?.sizeLabel ?? '250 g'}</small>
                </div>
                <button
                  className="add"
                  disabled={sold || !v}
                  onClick={() => v && onAdd(v.id)}
                >
                  {sold ? 'Slutsåld' : 'Lägg i korg'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
