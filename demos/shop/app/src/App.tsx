import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, currentPrincipal, setPrincipal, kr, type Cart, type CastMember, type Me, type Quote } from './api';
import { Storefront } from './views/Storefront';
import { Orders } from './views/Orders';
import { Invoicing } from './views/Invoicing';
import { Portal } from './views/Portal';
import { Login } from './views/Login';
import { bagColor } from './components';

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

const canSeeOrders = (r: string) => r === 'shop-admin' || r === 'warehouse' || r === 'attacker';
const canSeeInvoicing = (r: string) => r === 'shop-admin' || r === 'attacker';
const canShop = (r: string) => r === 'shopper' || r === 'shop-admin';

export default function App() {
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [who, setWho] = useState<string>('');
  const [me, setMe] = useState<Me | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const route = useHashRoute();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const [cartId, setCartId] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [code, setCode] = useState('');
  const [pay, setPay] = useState<'invoice' | 'card'>('invoice');
  // The currently-applied valid code, tracked in a ref so re-pricing after cart
  // edits doesn't need it as a callback dependency.
  const appliedCode = useRef<string | undefined>(undefined);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reload, setReload] = useState(0);

  const notify = useCallback((msg: string, ok = false) => {
    setToast({ msg, ok });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    void api.cast().then(({ cast: c }) => {
      setCast(c);
      const saved = currentPrincipal();
      const current = Object.entries(c).find(([, m]) => m.principal === saved)?.[0];
      const pick = current ?? Object.keys(c)[0] ?? '';
      setWho(pick);
      if (c[pick]) setPrincipal(c[pick]!.principal);
    });
    void api.me().then(setMe).catch(() => setMe(null));
  }, []);

  // A live Better Auth session takes precedence over the dev persona picker —
  // exactly as the server resolves it. Logged in = a real 'shopper' principal.
  const session = me?.authenticated && me.via === 'better-auth' ? me : null;
  const member = cast[who];
  const role = session ? 'shopper' : member?.role ?? '';
  const display = session ? session.display ?? 'kund' : member?.name ?? '';
  const activeCustomerId = session ? session.customerId ?? undefined : member?.customerId;

  const switchTo = useCallback(
    (key: string) => {
      const m = cast[key];
      if (!m) return;
      setWho(key);
      setPrincipal(m.principal);
      // A cart is owned by its principal — a new persona starts fresh.
      setCartId(null);
      setCart(null);
      setDrawer(false);
      setReload((n) => n + 1);
      location.hash = m.role === 'shopper' ? '#/portal' : '#/';
    },
    [cast],
  );

  const refreshCart = useCallback(async (id: string) => {
    try {
      setCart(await api.cart(id));
    } catch {
      setCart(null);
    }
  }, []);

  // Keep the applied-code ref in sync with the latest valid quote.
  useEffect(() => {
    appliedCode.current = quote?.discountValid ? quote.discountCode ?? undefined : undefined;
  }, [quote]);

  // Re-price the cart (carrying any applied discount) — after every cart edit.
  const reprice = useCallback(async (id: string) => {
    try {
      setQuote(await api.quote(id, appliedCode.current));
    } catch {
      setQuote(null);
    }
  }, []);

  const applyCode = useCallback(async () => {
    if (!cartId) return;
    setQuote(await api.quote(cartId, code.trim() || undefined));
  }, [cartId, code]);

  const changeQty = useCallback(
    async (lineId: string, qty: number) => {
      if (!cartId) return;
      try {
        await api.setLineQty(cartId, lineId, qty);
        await refreshCart(cartId);
        await reprice(cartId);
        setReload((n) => n + 1);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, reprice, notify],
  );

  const addToCart = useCallback(
    async (variantId: string) => {
      try {
        let id = cartId;
        if (!id) {
          id = (await api.createCart()).id;
          setCartId(id);
        }
        await api.addToCart(id, variantId, 1);
        await refreshCart(id);
        await reprice(id);
        setReload((n) => n + 1); // availability drops live
        setDrawer(true);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, reprice, notify],
  );

  const removeLine = useCallback(
    async (lineId: string) => {
      if (!cartId) return;
      try {
        await api.removeLine(cartId, lineId);
        await refreshCart(cartId);
        await reprice(cartId);
        setReload((n) => n + 1);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, reprice, notify],
  );

  const checkout = useCallback(async () => {
    if (!cartId || !activeCustomerId) return;
    try {
      const { order } = await api.checkout(cartId, {
        customerId: activeCustomerId,
        paymentMethod: pay,
        ...(quote?.discountValid && quote.discountCode ? { discountCode: quote.discountCode } : {}),
      });
      notify(`Order #${order.number} lagd — ${kr(order.total_amount)}`, true);
      setCartId(null);
      setCart(null);
      setQuote(null);
      setDrawer(false);
      setCode('');
      setReload((n) => n + 1);
      location.hash = '#/portal';
    } catch (e) {
      notify((e as Error).message);
    }
  }, [cartId, activeCustomerId, pay, quote, notify]);

  const onLoggedIn = useCallback(async () => {
    // Carry the pre-login cart into the logged-in customer's own cart. Carts are
    // principal-owned, so: snapshot the items, release the old holds (still acting
    // as the pre-login principal so a scarce item won't self-block), switch, and
    // re-add under the new principal.
    const carry = (cart?.lines ?? []).map((l) => ({ variantId: l.variantId, qty: l.qty }));
    if (cartId && cart) {
      for (const l of cart.lines) {
        try {
          await api.removeLine(cartId, l.lineId);
        } catch {
          /* ignore */
        }
      }
    }
    setPrincipal(null); // stop sending the dev header — the session cookie takes over
    setMe(await api.me());
    setLoginOpen(false);

    let newId: string | null = null;
    if (carry.length) {
      try {
        newId = (await api.createCart()).id;
        for (const c of carry) await api.addToCart(newId, c.variantId, c.qty);
      } catch {
        newId = null;
      }
    }
    setCartId(newId);
    setCart(newId ? await api.cart(newId) : null);
    if (newId) await reprice(newId);
    setReload((n) => n + 1);
    if (carry.length && newId) {
      setDrawer(true);
      location.hash = '#/';
      notify('Inloggad — varukorgen behölls', true);
    } else {
      location.hash = '#/portal';
      notify('Inloggad', true);
    }
  }, [cart, cartId, reprice, notify]);

  const onLogout = useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      /* ignore */
    }
    setMe(null);
    const firstKey = Object.keys(cast)[0] ?? '';
    setWho(firstKey);
    if (cast[firstKey]) setPrincipal(cast[firstKey]!.principal);
    setCartId(null);
    setCart(null);
    setReload((n) => n + 1);
    location.hash = '#/';
  }, [cast]);

  const count = useMemo(() => cart?.lines.reduce((a, l) => a + l.qty, 0) ?? 0, [cart]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  let view = <Storefront onAdd={addToCart} reloadKey={reload} />;
  if (route.startsWith('/orders')) view = <Orders key={who} notify={notify} />;
  else if (route.startsWith('/invoicing')) view = <Invoicing key={who} notify={notify} />;
  else if (route.startsWith('/portal')) view = <Portal reloadKey={reload} />;

  const tab = (to: string, label: string, on: boolean) =>
    on ? (
      <a href={`#${to}`} className={route === to || (to !== '/' && route.startsWith(to)) ? 'active' : ''}>
        {label}
      </a>
    ) : null;

  return (
    <>
      <header className="bar">
        <div className="wrap bar-in">
          <a className="brand" href="#/">
            <span className="drop" aria-hidden="true" />
            <span className="mark">Kallkälla</span>
          </a>
          <nav className="main">
            {tab('/', 'Butik', true)}
            {tab('/portal', 'Mina ordrar', role === 'shopper')}
            {tab('/orders', 'Orderbok', canSeeOrders(role))}
            {tab('/invoicing', 'Fakturaunderlag', canSeeInvoicing(role))}
          </nav>
          <div className="bar-right">
            {session ? (
              <div className="persona">
                <span className="role-badge">🔑 {display}</span>
                <button className="icon-btn" onClick={onLogout}>
                  Logga ut
                </button>
              </div>
            ) : (
              <div className="persona">
                <select value={who} onChange={(e) => switchTo(e.target.value)} aria-label="Välj användare">
                  {Object.entries(cast).map(([key, m]) => (
                    <option key={key} value={key}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <span className={`role-badge${role === 'attacker' ? ' attacker' : ''}`}>{role || '—'}</span>
                <button className="icon-btn" onClick={() => setLoginOpen(true)}>
                  Logga in
                </button>
              </div>
            )}
            <button className="icon-btn sq" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} aria-label="Växla tema">
              ◐
            </button>
            {canShop(role) && (
              <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Öppna varukorg">
                Varukorg <span className="cart-count">{count}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {view}

      <div className={`overlay${drawer ? ' open' : ''}`} onClick={() => setDrawer(false)} />
      <aside className={`cart${drawer ? ' open' : ''}`} aria-hidden={!drawer}>
        <div className="cart-h">
          <h3>Din varukorg</h3>
          <button className="x" onClick={() => setDrawer(false)} aria-label="Stäng">
            ×
          </button>
        </div>
        <div className="lines">
          {!cart || cart.lines.length === 0 ? (
            <div className="empty">Din varukorg är tom.<br />Lägg till en påse färskrostat.</div>
          ) : (
            cart.lines.map((l) => (
              <div className="line" key={l.lineId}>
                <div className="thumb" style={{ ['--bag' as string]: bagColor(l.sku.slice(0, 4).toLowerCase()) }} />
                <div>
                  <div className="l-name">{l.name}</div>
                  <div className="l-var">{l.grind} · {l.sizeLabel}</div>
                  <div className="qty">
                    <button aria-label="Minska antal" onClick={() => changeQty(l.lineId, l.qty - 1)}>
                      −
                    </button>
                    <span className="num">{l.qty}</span>
                    <button aria-label="Öka antal" onClick={() => changeQty(l.lineId, l.qty + 1)}>
                      +
                    </button>
                  </div>
                </div>
                <div>
                  <div className="l-price">{kr(l.lineTotal.amount)}</div>
                  <button className="rm" onClick={() => removeLine(l.lineId)}>
                    Ta bort
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="cart-f">
          <div className="code">
            <input
              placeholder="Rabattkod"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void applyCode();
              }}
              aria-label="Rabattkod"
            />
            <button onClick={applyCode}>Använd</button>
          </div>
          {quote?.message && <div className="code-msg err">{quote.message}</div>}
          {quote?.discountValid && (
            <div className="code-msg ok">Rabattkod {quote.discountCode} tillämpad</div>
          )}
          <div className="field">
            <label>Betalsätt</label>
            <select value={pay} onChange={(e) => setPay(e.target.value as 'invoice' | 'card')}>
              <option value="invoice">Mot faktura (skapar underlag)</option>
              <option value="card">Kort (ingen faktura)</option>
            </select>
          </div>
          <div className="totals">
            <div className="r">
              <span>Delsumma</span>
              <span>{kr(quote?.subtotal.amount ?? cart?.subtotal.amount ?? '0')}</span>
            </div>
            {quote?.discountValid && (
              <div className="r disc">
                <span>Rabatt {quote.discountCode}</span>
                <span>−{kr(quote.discount.amount)}</span>
              </div>
            )}
            <div className="r tot">
              <span>Att betala</span>
              <span>{kr(quote?.total.amount ?? cart?.subtotal.amount ?? '0')}</span>
            </div>
          </div>
          {activeCustomerId ? (
            <button className="btn" style={{ width: '100%' }} disabled={!cart || cart.lines.length === 0} onClick={checkout}>
              Slutför köp
            </button>
          ) : (
            <button
              className="btn"
              style={{ width: '100%' }}
              onClick={() => {
                setDrawer(false);
                setLoginOpen(true);
              }}
            >
              Logga in för att slutföra köpet
            </button>
          )}
          <div className="faktura-note">Rabatt räknas av i kassan; summan bekräftas på ordern.</div>
        </div>
      </aside>

      {loginOpen && <Login onDone={onLoggedIn} onCancel={() => setLoginOpen(false)} />}
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}
    </>
  );
}
