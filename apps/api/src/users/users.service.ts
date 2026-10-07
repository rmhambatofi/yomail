import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { normalizeEmail } from '@yomail/shared';
import type { UserProfile, UserRole, UserStatus } from '@yomail/shared';
import { PasswordService } from './password.service';
import { User } from './user.entity';

export interface CreateUserParams {
  username: string;
  email: string;
  password: string;
  role: UserRole;
  /** DISABLED for the web sign-up (confirmation pending), ENABLED for CLI admins. */
  status: UserStatus;
}

/** Thrown by create() when the email or username is already used. */
export class DuplicateUserError extends Error {
  constructor(public readonly field: 'email' | 'username') {
    super(`${field} already taken`);
    this.name = 'DuplicateUserError';
  }
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    @InjectDataSource() private readonly db: DataSource,
    private readonly passwords: PasswordService,
  ) {}

  toProfile(user: User): UserProfile {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      created_at: user.createdAt.toISOString(),
    };
  }

  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email: normalizeEmail(email) } });
  }

  /** The unique index collation (utf8mb4_unicode_ci) makes this lookup case-insensitive. */
  findByUsername(username: string): Promise<User | null> {
    return this.repo.findOne({ where: { username: username.trim() } });
  }

  /** Email when the identifier contains `@`, username otherwise. */
  findByIdentifier(identifier: string): Promise<User | null> {
    return identifier.includes('@')
      ? this.findByEmail(identifier)
      : this.findByUsername(identifier);
  }

  /**
   * Inserts a new account. Pre-checks give a clear field name; the unique
   * indexes remain the source of truth, so a concurrent insert surfaces as
   * DuplicateUserError too (MySQL ER_DUP_ENTRY names the index).
   */
  async create(params: CreateUserParams): Promise<User> {
    const email = normalizeEmail(params.email);
    const username = params.username.trim();
    if (await this.findByEmail(email)) throw new DuplicateUserError('email');
    if (await this.findByUsername(username)) throw new DuplicateUserError('username');

    const now = new Date();
    const user = this.repo.create({
      id: randomUUID(),
      username,
      email,
      passwordHash: await this.passwords.hash(params.password),
      status: params.status,
      role: params.role,
      createdAt: now,
      updatedAt: now,
      enabledAt: params.status === 'ENABLED' ? now : null,
      deletedAt: null,
      lastLoginAt: null,
    });
    try {
      await this.repo.insert(user);
    } catch (err) {
      const dup = duplicateField(err);
      if (dup) throw new DuplicateUserError(dup);
      throw err;
    }
    return user;
  }

  /** DISABLED -> ENABLED after the confirmation email. */
  async enable(user: User): Promise<void> {
    const now = new Date();
    await this.repo.update({ id: user.id }, { status: 'ENABLED', enabledAt: now, updatedAt: now });
    user.status = 'ENABLED';
    user.enabledAt = now;
  }

  async setPassword(user: User, password: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    await this.repo.update({ id: user.id }, { passwordHash, updatedAt: new Date() });
    user.passwordHash = passwordHash;
  }

  verifyPassword(user: User | null, password: string): Promise<boolean> {
    return this.passwords.verify(password, user?.passwordHash ?? '');
  }

  async markLogin(user: User): Promise<void> {
    await this.repo.update({ id: user.id }, { lastLoginAt: new Date() });
  }

  /**
   * Soft delete requested by the owner: the row stays (status DELETED) but the
   * identifiers are replaced so they become available again, the hash is
   * cleared, sessions and tokens go away, and the endpoints survive anonymously.
   */
  async anonymizeAndDelete(user: User): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM `sessions` WHERE `user_id` = ?', [user.id]);
      await tx.query('DELETE FROM `user_tokens` WHERE `user_id` = ?', [user.id]);
      await tx.query('UPDATE `endpoints` SET `owner_id` = NULL WHERE `owner_id` = ?', [user.id]);
      await tx.getRepository(User).update(
        { id: user.id },
        {
          status: 'DELETED',
          deletedAt: now,
          updatedAt: now,
          email: `deleted+${user.id}@invalid`,
          username: `deleted_${user.id.slice(0, 8)}`,
          passwordHash: '',
        },
      );
    });
  }
}

function duplicateField(err: unknown): 'email' | 'username' | null {
  const e = err as { code?: string; message?: string };
  if (e?.code !== 'ER_DUP_ENTRY') return null;
  if (e.message?.includes('uq_users_email')) return 'email';
  if (e.message?.includes('uq_users_username')) return 'username';
  return null;
}
