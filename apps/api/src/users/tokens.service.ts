import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { Env } from '../config/env';
import { hashToken } from './sessions.service';
import { UserToken } from './user-token.entity';
import type { UserTokenKind } from './user-token.entity';
import { User } from './user.entity';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Single-use tokens carried by email links. Issuing a token of a kind deletes
 * the user's previous tokens of that kind, so only the latest email works.
 * Consumption marks the row used (the purge removes it later) and returns the
 * user, or null when the token is unknown, expired, already used or of
 * another kind.
 */
@Injectable()
export class TokensService {
  readonly confirmTtlHours: number;
  readonly resetTtlMinutes: number;

  constructor(
    @InjectRepository(UserToken) private readonly repo: Repository<UserToken>,
    @InjectRepository(User) private readonly users: Repository<User>,
    config: ConfigService<Env, true>,
  ) {
    this.confirmTtlHours = config.get('CONFIRM_TOKEN_TTL_HOURS', { infer: true });
    this.resetTtlMinutes = config.get('RESET_TOKEN_TTL_MINUTES', { infer: true });
  }

  /** Returns the raw token to embed in the link. */
  async issue(user: User, kind: UserTokenKind): Promise<string> {
    const ttlMs =
      kind === 'CONFIRM_EMAIL'
        ? this.confirmTtlHours * 60 * 60 * 1000
        : this.resetTtlMinutes * 60 * 1000;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.repo.delete({ userId: user.id, kind });
    await this.repo.insert(
      this.repo.create({
        id: randomUUID(),
        userId: user.id,
        kind,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
        usedAt: null,
      }),
    );
    return token;
  }

  async consume(token: string, kind: UserTokenKind): Promise<User | null> {
    if (!TOKEN_SHAPE.test(token)) return null;
    const now = new Date();
    const row = await this.repo.findOne({ where: { tokenHash: hashToken(token), kind } });
    if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) return null;
    // Atomic claim: a concurrent request with the same token loses here.
    const claimed = await this.repo.update({ id: row.id, usedAt: IsNull() }, { usedAt: now });
    if (!claimed.affected) return null;
    return this.users.findOne({ where: { id: row.userId } });
  }
}
