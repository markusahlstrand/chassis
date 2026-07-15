import type { CatalogVariant } from './api';

const BAG_COLORS = ['#24463a', '#2f5551', '#2c3e52', '#6b3f34', '#3a2a22', '#3e2e43'];
export function bagColor(slug: string): string {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BAG_COLORS[h % BAG_COLORS.length]!;
}

export function RoastDots({ level }: { level: number }) {
  return (
    <span className="roast" aria-label={`rostning ${level}/3`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= level ? 'on' : ''} />
      ))}
    </span>
  );
}

export function Bag({ name, origin, roast, slug }: { name: string; origin: string; roast: number; slug: string }) {
  return (
    <div className="bagwrap">
      <div className="bag" style={{ ['--bag' as string]: bagColor(slug) }} role="img" aria-label={`Kaffepåse ${name}`}>
        <div className="bmark">Kallkälla</div>
        <span className="valve" aria-hidden="true" />
        <div className="blabel">
          <div className="borigin">{origin}</div>
          <div className="bname">{name}</div>
          <span className="broast" aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <i key={i} className={i <= roast ? 'on' : ''} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

export function StockChip({ available }: { available: number }) {
  if (available <= 0) return <span className="stock out"><span className="dot" />Slutsåld</span>;
  if (available <= 8)
    return (
      <span className="stock low">
        <span className="dot" />
        <span className="num">{available}</span> kvar
      </span>
    );
  return <span className="stock ok"><span className="dot" />I lager</span>;
}

export function cheapestVariant(variants: CatalogVariant[]): CatalogVariant | undefined {
  return [...variants].sort((a, b) => Number(a.price.amount) - Number(b.price.amount))[0];
}
