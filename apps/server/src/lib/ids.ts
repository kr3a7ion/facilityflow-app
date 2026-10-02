import { randomBytes } from 'node:crypto';

/**
 * ULID: sortable like an integer, unique like a UUID.
 * Means a second property, an export/import, or a merged dataset can never collide.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RAND_LEN);
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) out += ENCODING[bytes[i]! % 32]!;
  return out;
}

export function ulid(at: number = Date.now()): string {
  return encodeTime(at) + encodeRandom();
}

/** Opaque, high-entropy session identifier. Not a ULID — must not be guessable or sortable. */
export function sessionId(): string {
  return randomBytes(32).toString('base64url');
}
