// Minimal ULID: 48-bit timestamp + 80-bit random, Crockford base32.
// Kept dependency-free; kernel IDs must be sortable and opaque.
//
// MONOTONIC within a process (the ULID spec's monotonic factory): two IDs minted
// in the same millisecond still sort in creation order — the low bits increment
// instead of being re-randomized. This is load-bearing: the audit log and the
// event outbox both document "ULID order is chronological" and order by id, so a
// non-monotonic id would make same-millisecond rows sort randomly.

// WebCrypto is a global on every WinterTC runtime (Workers, Node 18+, Bun, Deno);
// declared locally so the kernel needs no platform type packages (§5.8).
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Monotonic state (per process/isolate — exactly the scope where a single writer
// orders its own rows). The random part is held as 16 base32 digits (0–31).
let lastTime = -1;
const lastRand: number[] = new Array<number>(16).fill(0);

function freshRandom(): void {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) lastRand[i] = bytes[i]! % 32; // 256 % 32 === 0 → uniform
}

/** Step the 80-bit random part by one, with carry. Returns false on overflow. */
function incrementRandom(): boolean {
  for (let i = 15; i >= 0; i--) {
    if (lastRand[i]! < 31) {
      lastRand[i]!++;
      return true;
    }
    lastRand[i] = 0;
  }
  return false; // all digits were 31 — overflowed (astronomically rare)
}

export function ulid(now: number = Date.now()): string {
  let time = now;
  if (time <= lastTime) {
    // Same or backwards clock: keep the last timestamp and step the random part
    // so the id still increases. On the (impossible) overflow, bump the ms.
    time = lastTime;
    if (!incrementRandom()) {
      time = lastTime + 1;
      freshRandom();
    }
  } else {
    freshRandom();
  }
  lastTime = time;

  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let r = '';
  for (const d of lastRand) r += B32[d];
  return ts + r;
}
