import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { USER_ROLES, USER_STATUSES } from '@yomail/shared';
import type { UserRole, UserStatus } from '@yomail/shared';

/**
 * A registered account. Created DISABLED by the web sign-up and switched to
 * ENABLED by the confirmation email; admins are created ENABLED by the CLI.
 * DELETED rows are kept but anonymized (email, username and hash cleared) so
 * the identifiers become free again. Never confirmed accounts are purged after
 * UNCONFIRMED_USER_TTL_DAYS.
 */
@Entity({ name: 'users' })
@Index('uq_users_username', ['username'], { unique: true })
@Index('uq_users_email', ['email'], { unique: true })
@Index('idx_users_status_created', ['status', 'createdAt'])
export class User {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id: string;

  /** Original case kept for display; unique case-insensitively (utf8mb4_unicode_ci). */
  @Column({ name: 'username', type: 'varchar', length: 32 })
  username: string;

  /** Stored lowercase (normalizeEmail). */
  @Column({ name: 'email', type: 'varchar', length: 254 })
  email: string;

  /** `scrypt$N$r$p$<salt b64>$<hash b64>`; empty string once the account is DELETED. */
  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ name: 'status', type: 'enum', enum: USER_STATUSES, default: 'DISABLED' })
  status: UserStatus;

  @Column({ name: 'role', type: 'enum', enum: USER_ROLES, default: 'STANDARD' })
  role: UserRole;

  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  /** Maintained by the service (no DB trigger). */
  @Column({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt: Date;

  /** Confirmation date (creation date for CLI admins); null = never confirmed. */
  @Column({ name: 'enabled_at', type: 'datetime', precision: 3, nullable: true })
  enabledAt: Date | null;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt: Date | null;

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt: Date | null;
}
