import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';

/**
 * A login session. The cookie carries a random opaque token; only its SHA-256
 * is stored, so a database leak does not yield usable cookies. Sessions live
 * in the database (not in memory) because Passenger runs several processes.
 * Fixed lifetime: expires_at = created_at + SESSION_TTL_DAYS, no sliding renewal.
 */
@Entity({ name: 'sessions' })
@Index('uq_sessions_token', ['tokenHash'], { unique: true })
@Index('idx_sessions_user', ['userId'])
@Index('idx_sessions_expires', ['expiresAt'])
export class Session {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_sessions_user' })
  user?: User;

  /** SHA-256 hex of the cookie token. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  /** Rewritten at most every 5 minutes to limit writes. */
  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3 })
  lastSeenAt: Date;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true })
  ip: string | null;
}
