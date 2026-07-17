import { useState } from 'react';
import { Card } from '../components';
import { signIn } from '../lib/auth';

/**
 * The staff sign-in screen (first-flow.md slice 3). Real auth gates EXPOSING the
 * console (control-plane.md §6): the control plane refuses every request without a
 * session, so this is the only way in when no dev actor is configured.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email, password);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const field: React.CSSProperties = {
    width: '100%',
    height: 34,
    padding: '0 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-default)',
    background: 'var(--surface-card)',
    color: 'var(--text-primary)',
    fontSize: 13.5,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--surface-page)' }}>
      <Card title="Substrat control plane" description="Staff sign-in — cross-tenant reach, so real auth gates the door (§6).">
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 320, marginTop: 4 }}>
          <input
            style={field}
            type="email"
            placeholder="Email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            style={field}
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <span style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</span>}
          <button
            type="submit"
            disabled={busy || !email || !password}
            style={{
              height: 34,
              borderRadius: 'var(--radius-sm)',
              border: 0,
              background: 'var(--brand-600, #3b6cf6)',
              color: '#fff',
              fontSize: 13.5,
              fontWeight: 600,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy || !email || !password ? 0.6 : 1,
            }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </Card>
    </div>
  );
}
