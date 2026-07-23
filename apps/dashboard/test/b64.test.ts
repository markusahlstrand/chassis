import { describe, it, expect } from 'vitest';
import { b64url, b64urlToBytes } from '../src/b64.js';

/**
 * The padding bug that only shows on Cloudflare's strict `atob`: a 32-byte HMAC
 * signature encodes to 43 base64url chars (no padding), and decoding must re-add the
 * `=` or `atob` throws "invalid base64-encoded data". These lock the round-trip for
 * every byte-length remainder mod 4, so the token verify path can't regress again.
 */
describe('base64url round-trip', () => {
  it('round-trips byte arrays of every length-mod-4 (incl. the 32-byte HMAC case)', () => {
    for (const n of [1, 2, 3, 31, 32, 33, 64, 100]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256);
      const round = b64urlToBytes(b64url(bytes));
      expect([...round]).toEqual([...bytes]);
    }
  });

  it('decodes an unpadded 43-char (32-byte) token without throwing', () => {
    const sig = new Uint8Array(32).fill(200);
    const encoded = b64url(sig);
    expect(encoded).toHaveLength(43); // no '=' padding — the shape that broke atob
    expect(() => b64urlToBytes(encoded)).not.toThrow();
    expect(b64urlToBytes(encoded)).toEqual(sig);
  });

  it('emits url-safe alphabet only (no +, /, or =)', () => {
    const bytes = new Uint8Array(48).map((_, i) => (i * 251) % 256);
    expect(b64url(bytes)).not.toMatch(/[+/=]/);
  });
});
