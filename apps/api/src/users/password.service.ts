import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * Password hashing with Node's built-in scrypt (no native module to compile on
 * cPanel). Stored form: `scrypt$N$r$p$<salt b64>$<hash b64>`; the parameters are
 * part of the string so they can be raised later without invalidating old rows.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** 128 * N * r bytes are needed; the default 32 MiB limit is exactly that, so raise it. */
const MAX_MEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await derive(password, salt, N, R, P);
    return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
  }

  /**
   * Constant-shape verification: an unparsable or empty stored hash (deleted
   * account, unknown user) still runs one scrypt so timing does not reveal
   * whether the identifier exists.
   */
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) {
      await derive(password, DUMMY_SALT, N, R, P);
      return false;
    }
    const key = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p);
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  }
}

const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 1);

function parse(
  stored: string,
): { n: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { n, r, p, salt, hash };
}
