import { useState, type CSSProperties } from 'react';
import { api, auth, ApiError } from './api';
import { Button, Card } from './ui';

const inp: CSSProperties = {
  font: 'inherit', fontSize: 14, width: '100%', padding: '10px 12px',
  borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)',
};

/**
 * Sign-in / first-run setup for a HOSTED instance (the deployed worker has no persona
 * picker — auth is the tenant's IdentityDO via Better Auth). On a freshly-installed
 * instance the owner seat is unclaimed (`needs-setup`), so the only path is to CREATE the
 * admin account, and the first sign-in claims that seat (→ admin). On success we reload so
 * `/api/me` resolves the new session cookie.
 */
/** An invited teammate arrived via ?invite=<token>: create their account (allowed by the
 *  token) and immediately claim the invite so their login binds to the pre-granted member. */
export function AcceptInvite({ token }: { token: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (busy || !email.trim() || password.length < 8) return;
    setBusy(true); setErr('');
    try {
      await auth.signUpWithInvite(email.trim(), password, name.trim() || email.trim(), token);
      await api.acceptInvite(token);
      window.history.replaceState({}, '', location.pathname + location.hash); // drop ?invite=
      location.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
      <Card style={{ width: 372 }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <span style={{ display: 'inline-block', width: 26, height: 26, borderRadius: 8, background: 'var(--accent)', marginBottom: 10 }} />
          <div style={{ fontSize: 20, fontWeight: 700 }}>Join the workspace</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>Create your account to accept the invite</div>
        </div>
        {err && <div style={{ padding: '9px 12px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gap: 10 }}>
          <input style={inp} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={inp} type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input style={inp} type="password" placeholder="Password (8+ characters)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
          <Button variant="primary" disabled={busy || !email.trim() || password.length < 8} onClick={() => void submit()}>
            {busy ? 'Please wait…' : 'Accept invite'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function SignIn({ firstRun }: { firstRun: boolean }) {
  const [mode, setMode] = useState<'in' | 'up'>(firstRun ? 'up' : 'in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (busy || !email.trim() || password.length < 8) return;
    setBusy(true); setErr('');
    try {
      if (mode === 'up') await auth.signUp(email.trim(), password, name.trim() || email.trim());
      else await auth.signIn(email.trim(), password);
      location.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
      <Card style={{ width: 372 }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <span style={{ display: 'inline-block', width: 26, height: 26, borderRadius: 8, background: 'var(--accent)', marginBottom: 10 }} />
          <div style={{ fontSize: 20, fontWeight: 700 }}>Manyfold</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            {firstRun ? 'Set up your workspace — create the admin account' : mode === 'in' ? 'Sign in to your workspace' : 'Create your account'}
          </div>
        </div>
        {err && <div style={{ padding: '9px 12px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gap: 10 }}>
          {mode === 'up' && <input style={inp} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />}
          <input style={inp} type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            style={inp} type="password" placeholder="Password (8+ characters)"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <Button variant="primary" disabled={busy || !email.trim() || password.length < 8} onClick={() => void submit()}>
            {busy ? 'Please wait…' : firstRun ? 'Create admin account' : mode === 'in' ? 'Sign in' : 'Create account'}
          </Button>
          {!firstRun && (
            <button type="button" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(''); }} style={{ background: 'none', border: 0, color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: 4 }}>
              {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          )}
          {firstRun && <div style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>You're the first here — this becomes the workspace admin.</div>}
        </div>
      </Card>
    </div>
  );
}
