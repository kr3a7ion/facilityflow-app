import { hash, verify, Algorithm } from '@node-rs/argon2';

/** Argon2id. Parameters chosen for an office desktop, not a server farm. */
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) throw new Error('password must be at least 8 characters');
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    return false;
  }
}
