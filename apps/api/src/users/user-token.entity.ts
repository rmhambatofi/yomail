import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';

export type UserTokenKind = 'CONFIRM_EMAIL' | 'RESET_PASSWORD';
export const USER_TOKEN_KINDS: readonly UserTokenKind[] = ['CONFIRM_EMAIL', 'RESET_PASSWORD'];

/**
 * Single-use token sent by email (account confirmation, password reset).
 * The link carries the random token; only its SHA-256 is stored. Issuing a
 * new token of a kind deletes the previous ones for that user. Used or
 * expired tokens are refused and removed by the purge.
 */
@Entity({ name: 'user_tokens' })
@Index('uq_user_tokens_token', ['tokenHash'], { unique: true })
@Index('idx_user_tokens_user', ['userId'])
@Index('idx_user_tokens_expires', ['expiresAt'])
export class UserToken {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_user_tokens_user' })
  user?: User;

  @Column({ name: 'kind', type: 'enum', enum: USER_TOKEN_KINDS })
  kind: UserTokenKind;

  /** SHA-256 hex of the token in the link. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash: string;

  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;

  /** Set when consumed; a consumed token is never accepted again. */
  @Column({ name: 'used_at', type: 'datetime', precision: 3, nullable: true })
  usedAt: Date | null;
}
