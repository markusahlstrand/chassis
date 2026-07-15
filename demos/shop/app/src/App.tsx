import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, currentPrincipal, setPrincipal, kr, type Cart, type CastMember, type Me } from './api';
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
  const [drawer, setDrawer] = useState(false);
  const [code, setCode] = useState('');
  const [pay, setPay] = useState<'invoice' | 'card'>('invoice');
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
        setReload((n) => n + 1); // availability drops live
        setDrawer(true);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, notify],
  );

  const removeLine = useCallback(
    async (lineId: string) => {
      if (!cartId) return;
      try {
        await api.removeLine(cartId, lineId);
        await refreshCart(cartId);
        setReload((n) => n + 1);
      } catch (e) {
        notify((e as Error).message);
      }
    },
    [cartId, refreshCart, notify],
  );

  const checkout = useCallback(async () => {
    if (!cartId || !activeCustomerId) return;
    try {
      const { order } = await api.checkout(cartId, {
        customerId: activeCustomerId,
        paymentMethod: pay,
        ...(code.trim() ? { discountCode: code.trim() } : {}),
      });
      notify(`Order #${order.number} lagd — ${kr(order.total_amount)}`, true);
      setCartId(null);
      setCart(null);
      setDrawer(false);
      setCode('');
      setReload((n) => n + 1);
      location.hash = '#/portal';
    } catch (e) {
      notify((e as Error).message);
    }
  }, [cartId, activeCustomerId, pay, code, notify]);

  const onLoggedIn = useCallback(async () => {
    setPrincipal(null); // stop sending the dev header — the session cookie takes over
    setMe(await api.me());
    setLoginOpen(false);
    setCartId(null);
    setCart(null);
    setReload((n) => n + 1);
    location.hash = '#/portal';
    notify('Inloggad', true);
  }, [notify]);

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
                  <div className="l-var">
                    {l.grind} · {l.sizeLabel} · ×{l.qty}
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
              aria-label="Rabattkod"
            />
          </div>
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
              <span>{kr(cart?.subtotal.amount ?? '0')}</span>
            </div>
            <div className="r tot">
              <span>Att betala</span>
              <span>{kr(cart?.subtotal.amount ?? '0')}</span>
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
