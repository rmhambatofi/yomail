import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { ResponseConfig } from '@yomail/shared';
import { User } from '../users/user.entity';

/**
 * A capture endpoint. Created explicitly (POST /api/endpoints); requests to an
 * unknown id are refused with 404. Purged when idle longer than retention_days:
 * COALESCE(last_request_at, created_at) < cutoff (see PurgeService).
 * Optionally owned by a user (set when created with a valid session); the
 * inbox itself stays public to anyone who knows the id.
 */
@Entity({ name: 'endpoints' })
export class Endpoint {
  /** UUID v4 generated server-side with crypto.randomUUID(), stored lowercase. */
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id: string;

  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;

  /** Null until the first captured request. */
  @Index('idx_endpoints_last_request')
  @Column({ name: 'last_request_at', type: 'datetime', precision: 3, nullable: true })
  lastRequestAt: Date | null;

  /** Null for anonymous endpoints; cleared (FK SET NULL) when the owner row is removed. */
  @Index('idx_endpoints_owner')
  @Column({ name: 'owner_id', type: 'char', length: 36, nullable: true })
  ownerId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'owner_id', foreignKeyConstraintName: 'fk_endpoints_owner' })
  owner?: User | null;

  /** Display name chosen by the owner (phase 8); no uniqueness. */
  @Column({ name: 'name', type: 'varchar', length: 80, nullable: true })
  name: string | null;

  /** Owner-configured response (phase 8); null = default `200 {"ok":true,"id"}`. */
  @Column({ name: 'response_config', type: 'json', nullable: true })
  responseConfig: ResponseConfig | null;
}
