/**
 * base64url ⇄ bytes, for the HMAC-signed tokens (invites, OAuth state).
 *
 * The one thing that MUST be right here and only bites at runtime: decoding must
 * re-add `=` padding. base64url drops it, and Cloudflare's `atob` — unlike Node's —
 * rejects input whose length isn't a multiple of 4. An HMAC-SHA256 signature is 32
 * bytes → 43 base64url chars, so without padding every token verify throws
 * "invalid base64-encoded data". Extracted + tested precisely so that can't regress.
 */

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  // Re-add the padding base64url stripped, up to the next multiple of 4.
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
};
