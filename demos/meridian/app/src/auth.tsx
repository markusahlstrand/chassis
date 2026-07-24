import { useState } from 'react';
import { auth, ApiError } from './api';
import { Button } from './ui';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 12,
  border: '1px solid var(--card-border)',
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 15,
};

/**
 * Sign-in / sign-up for a HOSTED instance. Production has no persona switcher — the real
 * user authenticates via Better Auth (the tenant's IdentityDO, behind the AuthProvider
 * contract). On a freshly-installed instance the FIRST sign-in claims the owner seat
 * (→ hr-admin), so the installer lands on the Admin/setup surface. On success we reload
 * so `/api/me` resolves the new session cookie.
 */
export function SignIn({ onDone, firstRun = false }: { onDone: () => void; firstRun?: boolean }) {
  // First run: this instance has no admin yet, so the only path is to CREATE the admin
  // account (which claims the owner seat). Force sign-up and drop the "sign in instead"
  // toggle — there is nothing to sign in to yet.
  const [mode, setMode] = useState<'in' | 'up'>(firstRun ? 'up' : 'in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !email.trim() || password.length < 8) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'up') await auth.signUp(email.trim(), password, name.trim() || email.trim());
      else await auth.signIn(email.trim(), password);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="phone">
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 360, display: 'grid', gap: 14 }}>
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <div className="brand-mark" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>Meridian</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {firstRun
                ? 'Set up your workspace — create the admin account'
                : mode === 'in'
                  ? 'Sign in to your HR workspace'
                  : 'Create your account'}
            </div>
          </div>
          {err && <div className="err-banner">{err}</div>}
          {mode === 'up' && (
            <input style={inputStyle} placeholder="Full name" aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input
            style={inputStyle}
            type="email"
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            style={inputStyle}
            type="password"
            placeholder="Password (8+ characters)"
            aria-label="Password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <Button disabled={busy || !email.trim() || password.length < 8} onClick={() => void submit()}>
            {busy ? 'Please wait…' : firstRun ? 'Create admin account' : mode === 'in' ? 'Sign in' : 'Create account'}
          </Button>
          {!firstRun && (
            <button
              type="button"
              onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); }}
              style={{ background: 'none', border: 0, color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: 4 }}
            >
              {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          )}
          {firstRun && (
            <div className="muted" style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>
              You’re the first here — this becomes the workspace admin. Teammates join by invite afterwards.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
