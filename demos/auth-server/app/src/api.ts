import { createAuthClient } from 'better-auth/client';
import { adminClient } from 'better-auth/client/plugins';

/**
 * The Better Auth browser client, pointed at THIS issuer (same origin, `/api/auth`). The
 * dashboard is the issuer's own first relying party: it signs in here and the `adminClient`
 * gives it the typed admin surface (list/create/ban/role/remove) — all gated server-side by
 * the `admin` role, so a non-admin session can call nothing.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient()],
});

export interface Session {
  sub: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  emailVerified?: boolean;
  createdAt?: string | Date;
}

/** Is the issuer awaiting its first administrator? */
export async function setupState(): Promise<{ needsSetup: boolean }> {
  const res = await fetch('/api/setup-state');
  return res.json();
}

/** Create the first administrator (only possible while there are no users). */
export async function createFirstAdmin(body: { email: string; password: string; name: string }): Promise<void> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'setup failed');
}

/** The current session (subject + role), or null. */
export async function currentSession(): Promise<Session | null> {
  const res = await fetch('/api/session');
  return res.json();
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await authClient.signIn.email({ email, password });
  if (error) throw new Error(error.message ?? 'sign-in failed');
}

export async function signOut(): Promise<void> {
  await authClient.signOut();
}

/** Request a password-reset email (sent through the email adapter). */
export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
  if (error) throw new Error(error.message ?? 'could not send reset email');
}

export async function listUsers(): Promise<AdminUser[]> {
  const { data, error } = await authClient.admin.listUsers({ query: { limit: 200 } });
  if (error) throw new Error(error.message ?? 'could not list users');
  return (data?.users ?? []) as AdminUser[];
}

export async function createUser(body: { email: string; password: string; name: string; role: 'admin' | 'user' }): Promise<void> {
  const { error } = await authClient.admin.createUser(body);
  if (error) throw new Error(error.message ?? 'could not create user');
}

export async function setRole(userId: string, role: 'admin' | 'user'): Promise<void> {
  const { error } = await authClient.admin.setRole({ userId, role });
  if (error) throw new Error(error.message ?? 'could not set role');
}

export async function banUser(userId: string): Promise<void> {
  const { error } = await authClient.admin.banUser({ userId });
  if (error) throw new Error(error.message ?? 'could not ban user');
}

export async function unbanUser(userId: string): Promise<void> {
  const { error } = await authClient.admin.unbanUser({ userId });
  if (error) throw new Error(error.message ?? 'could not unban user');
}

export async function removeUser(userId: string): Promise<void> {
  const { error } = await authClient.admin.removeUser({ userId });
  if (error) throw new Error(error.message ?? 'could not remove user');
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  registration_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

/** The issuer's OIDC discovery document — shown in the dashboard so operators can wire RPs. */
export async function discovery(): Promise<Discovery | null> {
  const res = await fetch('/.well-known/openid-configuration');
  if (!res.ok) return null;
  return res.json();
}
