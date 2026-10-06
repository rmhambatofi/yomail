import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A capture endpoint. Created explicitly (POST /api/endpoints); requests to an
 * unknown id are refused with 404. Purged when idle longer than retention_days:
 * COALESCE(last_request_at, created_at) < cutoff (see PurgeService).
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
}
