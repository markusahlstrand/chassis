import { describe, expect, it } from 'vitest';
import { readRoutedNode, RouterAssertionError } from '../src/routed-node.js';

/**
 * The vertical's side of K-26's trust boundary. Everything here is the difference
 * between "serves the right tenant" and "serves whichever tenant the caller named",
 * so the negative cases matter more than the happy one.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

const routed = (extra: Record<string, string> = {}) =>
  headers({ 'x-substrat-tenant': T, 'x-substrat-scope': S, ...extra });

describe('readRoutedNode', () => {
  it('reads the asserted node', () => {
    const node = readRoutedNode(
      routed({ 'x-substrat-surface': 'back-office', 'x-substrat-vertical': 'shop' }),
    );
    expect(node).toEqual({
      tenantId: T,
      scopeId: S,
      surface: 'back-office',
      verticalSlug: 'shop',
    });
  });

  it('defaults the surface, since most verticals have exactly one', () => {
    expect(readRoutedNode(routed())?.surface).toBe('app');
  });

  it('returns null when no router fronted the request', () => {
    // Not an error: a standalone single-tenant deploy is legitimate. The CALLER
    // decides what to do with it, which is why this is distinct from a throw.
    expect(readRoutedNode(headers({}))).toBeNull();
    expect(readRoutedNode(headers({ 'x-substrat-router': 'shhh' }), { expectedSecret: 'shhh' }))
      .toBeNull();
  });

  it('refuses an assertion without the router secret', () => {
    // The case this exists for: the vertical worker is publicly reachable (a
    // forgotten workers.dev toggle) and a stranger names a tenant.
    expect(() => readRoutedNode(routed(), { expectedSecret: 'shhh' })).toThrow(
      RouterAssertionError,
    );
  });

  it('refuses an assertion with the WRONG router secret', () => {
    expect(() =>
      readRoutedNode(routed({ 'x-substrat-router': 'guess' }), { expectedSecret: 'shhh' }),
    ).toThrow(RouterAssertionError);
  });

  it('accepts the assertion when the secret matches', () => {
    expect(
      readRoutedNode(routed({ 'x-substrat-router': 'shhh' }), { expectedSecret: 'shhh' }),
    ).toMatchObject({ tenantId: T, scopeId: S });
  });

  it('does not compare secrets by prefix or length alone', () => {
    for (const presented of ['s', 'shh', 'shhhh', '']) {
      expect(() =>
        readRoutedNode(routed({ 'x-substrat-router': presented }), { expectedSecret: 'shhh' }),
      ).toThrow(RouterAssertionError);
    }
  });

  it('refuses a half-assertion rather than guessing the other half', () => {
    expect(() => readRoutedNode(headers({ 'x-substrat-tenant': T }))).toThrow(
      RouterAssertionError,
    );
    expect(() => readRoutedNode(headers({ 'x-substrat-scope': S }))).toThrow(
      RouterAssertionError,
    );
  });

  it('refuses ids that are not ULIDs', () => {
    // Parse, don't trust — even from the router. A malformed id reaching getScope
    // is a worse failure than a rejected request.
    expect(() => readRoutedNode(headers({ 'x-substrat-tenant': 'evil', 'x-substrat-scope': S })))
      .toThrow(RouterAssertionError);
    expect(() =>
      readRoutedNode(headers({ 'x-substrat-tenant': T, 'x-substrat-scope': '../../admin' })),
    ).toThrow(RouterAssertionError);
  });

  it('checks the secret before it checks anything else', () => {
    // An unauthenticated caller must not be able to tell a malformed id from a
    // well-formed one — that is a probe of the id space.
    expect(() =>
      readRoutedNode(headers({ 'x-substrat-tenant': 'nonsense', 'x-substrat-scope': 'junk' }), {
        expectedSecret: 'shhh',
      }),
    ).toThrow(/not signed by a known router/);
  });
});
