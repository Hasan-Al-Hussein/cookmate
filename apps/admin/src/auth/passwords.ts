import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { requireAdmin } from './errors';

const options = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export async function hashPassword(password: string): Promise<string> {
  requireAdmin(
    typeof password === 'string' &&
      password.length <= 256 &&
      [...password].length >= 12 &&
      [...password].length <= 128,
    400,
    'password_bounds',
    'Use a password between 12 and 128 characters.',
  );
  return argon2.hash(password, options);
}
/** Library-generated dummy verification keeps unknown usernames on the same password path. */
export function createPasswordVerifier() {
  let pending = 0;
  let dummy: Promise<string> | undefined;
  return async (hash: string | undefined, password: string): Promise<boolean> => {
    requireAdmin(
      pending < 2,
      429,
      'password_busy',
      'Too many sign-in attempts. Please try again shortly.',
    );
    pending++;
    try {
      dummy ??= argon2.hash(randomBytes(32), options);
      const result = await argon2.verify(hash ?? (await dummy), password);
      return hash !== undefined && result;
    } catch {
      return false;
    } finally {
      pending--;
    }
  };
}
