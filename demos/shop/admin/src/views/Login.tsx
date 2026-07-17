import { useState } from 'react';
import { api } from '../api';

/**
 * The back-office gate. Unlike the storefront there is no sign-up: staff
 * accounts are provisioned, not self-served. A shopper who authenticates here
 * gets in as far as the shell and no further — every operation still checks.
 */
export function Login({ onDone, denied }: { onDone: () => void; denied?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.signIn(email.trim(), password);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">
          <span className="drop" aria-hidden="true" />
          <span className="mark">
            Kallkälla
            <small>Back-office</small>
          </span>
        </div>
        <h2>Logga in</h2>
        <p className="sub">Personalinloggning för lager och administration.</p>
        {denied && <div className="gate-err" style={{ marginBottom: 10 }}>{denied}</div>}
        <form className="gate-form" onSubmit={submit}>
          <input
            type="email"
            placeholder="E-post"
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Lösenord"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {err && <div className="gate-err">{err}</div>}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Loggar in…' : 'Logga in'}
          </button>
        </form>
        <p className="hint">
          Demo: <code>astrid@kallkalla.se</code> (butikschef) eller <code>gustav@kallkalla.se</code> (lager)
          — lösenord <code>demo1234</code>. Gustav har <code>stock:manage</code> men inte{' '}
          <code>catalog:manage</code>: samma dashboard, färre knappar.
        </p>
      </div>
    </div>
  );
}
