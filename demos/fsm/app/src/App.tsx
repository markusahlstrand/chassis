import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  currentPrincipal,
  me,
  setHeaderAuth,
  setPrincipal,
  signIn,
  signOut,
  type CastMember,
  type Session,
} from './api';
import { OrdersView } from './views/Orders';
import { OrderDetailView } from './views/OrderDetail';
import { InvoicingView } from './views/Invoicing';
import { CustomersView } from './views/Customers';
import { PricesView } from './views/Prices';
import { PortalView } from './views/Portal';

function useHashRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/**
 * The app is auth-mode-aware: the same UI runs against the node/sqlite dev server
 * (persona `<select>` + `x-principal` header) and the Cloudflare Worker (Better
 * Auth session cookie). On mount we probe `/api/me`:
 *   - header mode  → the node server (no /api/me) → persona picker, as before
 *   - better-auth  → the Worker → session present renders the app, absent shows login
 */
type AuthState =
  | { kind: 'loading' }
  | { kind: 'header' }
  | { kind: 'better-auth'; session: Session | null };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

  const probe = useCallback(async () => {
    const result = await me();
    if (result.mode === 'header') {
      setHeaderAuth(true);
      setAuth({ kind: 'header' });
    } else {
      setHeaderAuth(false);
      setAuth({ kind: 'better-auth', session: result.session });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  if (auth.kind === 'loading') {
    return (
      <main className="page">
        <p className="muted">Laddar…</p>
      </main>
    );
  }
  if (auth.kind === 'header') return <HeaderModeApp />;
  if (!auth.session) return <LoginScreen onSignedIn={probe} />;
  return (
    <AuthedApp
      session={auth.session}
      onSignOut={async () => {
        await signOut();
        await probe();
      }}
    />
  );
}

/** The shared chrome (topbar + nav + routed view). `identity` is the right-hand slot. */
function AppShell({
  cast,
  isPortal,
  identity,
  sessionKey,
}: {
  cast: Record<string, CastMember>;
  isPortal: boolean;
  identity: ReactNode;
  sessionKey: string;
}) {
  const route = useHashRoute();

  let view = <OrdersView />;
  if (route.startsWith('/orders/')) view = <OrderDetailView orderId={route.split('/')[2] ?? ''} cast={cast} />;
  else if (route.startsWith('/invoicing')) view = <InvoicingView />;
  else if (route.startsWith('/customers')) view = <CustomersView />;
  else if (route.startsWith('/prices')) view = <PricesView />;
  else if (route.startsWith('/portal')) view = <PortalView />;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          Service<span>Co</span> <span className="muted" style={{ fontSize: 11 }}>on Substrat</span>
        </div>
        <nav>
          {!isPortal && (
            <>
              <a href="#/" className={route === '/' || route.startsWith('/orders') ? 'active' : ''}>
                Arbetsorder
              </a>
              <a href="#/invoicing" className={route.startsWith('/invoicing') ? 'active' : ''}>
                Fakturaunderlag
              </a>
              <a href="#/customers" className={route.startsWith('/customers') ? 'active' : ''}>
                Kunder
              </a>
              <a href="#/prices" className={route.startsWith('/prices') ? 'active' : ''}>
                Prislista
              </a>
            </>
          )}
          {isPortal && (
            <a href="#/portal" className={route.startsWith('/portal') ? 'active' : ''}>
              Mina ärenden
            </a>
          )}
        </nav>
        {identity}
      </header>
      <main className="page" key={`${sessionKey}:${route}`}>
        {view}
      </main>
    </>
  );
}

/** Node/sqlite dev server: the existing persona `<select>` + `x-principal` flow. */
function HeaderModeApp() {
  const [cast, setCast] = useState<Record<string, CastMember>>({});
  const [who, setWho] = useState<string>('');

  useEffect(() => {
    void api.cast().then((c) => {
      setCast(c);
      const saved = currentPrincipal();
      const current = Object.entries(c).find(([, m]) => m.principal === saved)?.[0];
      const fallback = Object.keys(c)[0] ?? '';
      const pick = current ?? fallback;
      setWho(pick);
      const member = c[pick];
      if (member) setPrincipal(member.principal);
    });
  }, []);

  const switchTo = useCallback(
    (key: string) => {
      const member = cast[key];
      if (!member) return;
      setWho(key);
      setPrincipal(member.principal);
      const isPortal = member.role === 'portal';
      location.hash = isPortal ? '#/portal' : '#/';
    },
    [cast],
  );

  const role = cast[who]?.role ?? '';
  const isPortal = role === 'portal';

  const identity = (
    <label>
      <select value={who} onChange={(e) => switchTo(e.target.value)}>
        {Object.entries(cast).map(([key, m]) => (
          <option key={key} value={key}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );

  return <AppShell cast={cast} isPortal={isPortal} identity={identity} sessionKey={who} />;
}

/** Cloudflare Worker: authenticated via a Better Auth session cookie. */
function AuthedApp({ session, onSignOut }: { session: Session; onSignOut: () => void | Promise<void> }) {
  const isPortal = session.role === 'portal';
  const identity = (
    <div className="row" style={{ gap: 10 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        {session.display} · {session.role}
      </span>
      <button className="btn" onClick={() => void onSignOut()}>
        Logga ut
      </button>
    </div>
  );
  return <AppShell cast={{}} isPortal={isPortal} identity={identity} sessionKey={session.principal} />;
}

/** Better Auth email+password login (Worker mode, no active session). */
function LoginScreen({ onSignedIn }: { onSignedIn: () => void | Promise<void> }) {
  const [email, setEmail] = useState('anna@elmontage.se');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(email, password);
      await onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="brand">
          Service<span>Co</span> <span className="muted" style={{ fontSize: 11 }}>on Substrat</span>
        </div>
      </header>
      <main className="page">
        <div className="card" style={{ maxWidth: 380, margin: '48px auto' }}>
          <h2>Logga in</h2>
          {error && <div className="alert error">{error}</div>}
          <form onSubmit={submit}>
            <div className="kv" style={{ gridTemplateColumns: '1fr', rowGap: 10 }}>
              <label>
                <div className="muted" style={{ marginBottom: 4 }}>
                  E-post
                </div>
                <input
                  style={{ width: '100%' }}
                  type="email"
                  value={email}
                  autoComplete="username"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                <div className="muted" style={{ marginBottom: 4 }}>
                  Lösenord
                </div>
                <input
                  style={{ width: '100%' }}
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? 'Loggar in…' : 'Logga in'}
              </button>
            </div>
          </form>
          <div className="alert info" style={{ marginTop: 16 }}>
            Demokonton:
            <br />
            <code>anna@elmontage.se</code> / <code>demo1234</code> — kontor (office-admin)
            <br />
            <code>harald@elmontage.se</code> / <code>demo1234</code> — tekniker (technician)
          </div>
        </div>
      </main>
    </>
  );
}
