import { useState } from 'react';
import { api } from '../api';

/** Customer sign-up / sign-in for the storefront. Talks to Better Auth via /api/auth/*. */
export function Login({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'signup') await api.signUp(email, password, name || email);
      else await api.signIn(email, password);
      await onDone();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay open" onClick={onCancel}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <div className="auth-h">
          <div className="brand">
            <span className="drop" aria-hidden="true" />
            <span className="mark">Kallkälla</span>
          </div>
          <button className="x" onClick={onCancel} aria-label="Stäng">
            ×
          </button>
        </div>
        <h2>{mode === 'signup' ? 'Skapa konto' : 'Logga in'}</h2>
        <p className="auth-sub">
          {mode === 'signup'
            ? 'Handla mot faktura och följ dina beställningar.'
            : 'Välkommen tillbaka.'}
        </p>
        <form onSubmit={submit} className="auth-form">
          {mode === 'signup' && (
            <div className="field">
              <label>Namn</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Café Pascal" autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label>E-post</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="du@exempel.se"
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label>Lösenord</label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="minst 8 tecken"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>
          {err && <div className="auth-err">{err}</div>}
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? '…' : mode === 'signup' ? 'Skapa konto' : 'Logga in'}
          </button>
        </form>
        <button
          className="auth-toggle"
          onClick={() => {
            setErr(null);
            setMode((m) => (m === 'signup' ? 'signin' : 'signup'));
          }}
        >
          {mode === 'signup' ? 'Har du redan ett konto? Logga in' : 'Ny kund? Skapa konto'}
        </button>
      </div>
    </div>
  );
}
