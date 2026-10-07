import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';
import type { Env } from '../config/env';
import { Session } from './session.entity';
import { User } from './user.entity';

const DAY_MS = 24 * 60 * 60 * 1000;
/** last_seen_at is rewritten at most this often. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionWithUser {
  session: Session;
  user: User;
}

/**
 * Database-backed login sessions. The cookie value is a 32-byte random token
 * (base64url, 43 chars); only its SHA-256 is stored. Lives in the database so
 * every Passenger process sees the same sessions and revocation is immediate.
 */
@Injectable()
export class SessionsService {
  private readonly ttlMs: number;

  constructor(
    @InjectRepository(Session) private readonly repo: Repository<Session>,
    @InjectRepository(User) private readonly users: Repository<User>,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('SESSION_TTL_DAYS', { infer: true }) * DAY_MS;
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  /** Creates a session and returns the raw token to put in the cookie. */
  async create(
    user: User,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const session = this.repo.create({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 255) : null,
      ip: meta.ip ? meta.ip.slice(0, 45) : null,
    });
    await this.repo.insert(session);
    return { token, session };
  }

  /**
   * Resolves a cookie token to its session and user, or null when unknown,
   * expired, or when the user is no longer ENABLED. Touches last_seen_at.
   */
  async resolve(token: string | undefined): Promise<SessionWithUser | null> {
    if (!token || !TOKEN_SHAPE.test(token)) return null;
    const session = await this.repo.findOne({ where: { tokenHash: hashToken(token) } });
    if (!session) return null;
    const now = new Date();
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.repo.delete({ id: session.id });
      return null;
    }
    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user || user.status !== 'ENABLED') return null;
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.repo.update({ id: session.id }, { lastSeenAt: now });
      session.lastSeenAt = now;
    }
    return { session, user };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.repo.delete({ id: sessionId });
  }

  /** Logs the user out everywhere, optionally keeping one session (password change). */
  async revokeAll(userId: string, exceptSessionId?: string): Promise<void> {
    await this.repo.delete(exceptSessionId ? { userId, id: Not(exceptSessionId) } : { userId });
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const result = await this.repo.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
