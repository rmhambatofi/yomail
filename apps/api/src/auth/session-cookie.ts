import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'yomail_session';

/** HttpOnly + SameSite=Lax (CSRF) + Secure in production (HTTPS only). */
export function setSessionCookie(
  res: Response,
  token: string,
  opts: { maxAgeSeconds: number; secure: boolean },
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.secure,
    path: '/',
    maxAge: opts.maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response, opts: { secure: boolean }): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.secure,
    path: '/',
  });
}

/**
 * Session token from a raw `Cookie` header (Socket.IO handshakes do not go through
 * cookie-parser). Same name, same percent-decoding as cookie-parser.
 */
export function sessionTokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** Raw cookie value, if cookie-parser ran on this request. */
export function readSessionCookie(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[SESSION_COOKIE];
  return typeof value === 'string' ? value : undefined;
}
