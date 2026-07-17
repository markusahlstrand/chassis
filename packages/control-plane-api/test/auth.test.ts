import { describe, expect, it } from 'vitest';
import { platformActorId } from '@substrat-run/contracts';
import { sessionPlatformAuth, staffAllowlist } from '../src/index.js';

/**
 * The staff-auth seam (first-flow.md slice 3): an authenticated session resolves
 * to a platform actor via a roster, and everyone else is refused. The provider
 * (Better Auth today) is mocked as a session reader — the point of the split is
 * that only that reader changes when the provider does.
 */
describe('sessionPlatformAuth + staffAllowlist', () => {
  const MARKUS = platformActorId.parse('01JZ00000000000000000000MK');
  const roster = staffAllowlist([{ email: 'markus@substrat.run', actor: MARKUS }]);
  const req = (session: { email: string } | null) =>
    sessionPlatformAuth(() => session, roster)(new Request('http://cp.local/tenants'));

  it('resolves a rostered staff session to its actor (case-insensitive)', async () => {
    expect(await req({ email: 'Markus@Substrat.run' })).toBe(MARKUS);
  });

  it('refuses an authenticated-but-unrostered session', async () => {
    expect(await req({ email: 'stranger@example.com' })).toBeNull();
  });

  it('refuses when there is no session at all', async () => {
    expect(await req(null)).toBeNull();
  });
});
