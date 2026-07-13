// Minimal ULID: 48-bit timestamp + 80 random bits, Crockford base32.
// Kept dependency-free; kernel IDs must be sortable and opaque.

// WebCrypto is a global on every WinterTC runtime (Workers, Node 18+, Bun, Deno);
// declared locally so the kernel needs no platform type packages (§5.8).
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let r = '';
  for (const b of rand) r += B32[b % 32]; // 256 % 32 === 0 → uniform
  return ts + r;
}
