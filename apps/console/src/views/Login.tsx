import { Card } from '../components';
import { signIn } from '../lib/auth';

/**
 * The staff sign-in screen (first-flow.md slice 3). Real auth gates EXPOSING the
 * console (control-plane.md §6): the control plane refuses every request without a
 * session, so this is the only way in when no dev actor is configured.
 *
 * Sign-in is a single button — it redirects into the OIDC flow (AuthHero); there is
 * no password here. A failed round-trip comes back as `?error=auth`.
 */
export function Login() {
  const failed = new URLSearchParams(window.location.search).get('error') === 'auth';

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: 'var(--surface-page)' }}>
      <Card title="Substrat control plane" description="Staff sign-in — cross-tenant reach, so real auth gates the door (§6).">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 320, marginTop: 4 }}>
          {failed && (
            <span style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
              Sign-in did not complete. Please try again.
            </span>
          )}
          <button
            type="button"
            onClick={() => signIn()}
            style={{
              height: 34,
              borderRadius: 'var(--radius-sm)',
              border: 0,
              background: 'var(--brand-600, #3b6cf6)',
              color: '#fff',
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Sign in
          </button>
        </div>
      </Card>
    </div>
  );
}
