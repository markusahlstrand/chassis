/**
 * Console staff auth (first-flow.md slice 3). Thin fetch calls to the control
 * plane's Better Auth routes, reached through the Vite proxy (`/api/auth/*` →
 * `/auth/*`). No client library — the same dependency-light approach the demo
 * app uses. When the provider changes (AuthHero), only these URLs/shapes move.
 *
 * The session cookie is same-origin (the proxy makes the console and the API
 * share an origin), so `credentials: 'include'` is all that carries it.
 */
export interface StaffSession {
  email: string;
}

export async function getSession(): Promise<StaffSession | null> {
  const res = await fetch('/api/auth/get-session', { credentials: 'include' });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
  return data?.user?.email ? { email: data.user.email } : null;
}

export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `sign-in failed (${res.status})`);
  }
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
}
