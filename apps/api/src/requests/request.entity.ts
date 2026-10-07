import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { CONTENT_KINDS } from '@yomail/shared';
import type { ContentKind, DroppedFile, Pair } from '@yomail/shared';
import { Endpoint } from '../endpoints/endpoint.entity';

/**
 * One captured HTTP request. Bodies are stored as received text, capped at
 * MAX_BODY_BYTES; multipart file parts and binary bodies are never stored.
 * `expires_at` is computed (received_at + retention_days), never persisted.
 */
@Entity({ name: 'requests' })
@Index('idx_requests_endpoint_received', ['endpointId', 'receivedAt'])
@Index('idx_requests_received', ['receivedAt'])
export class CapturedRequest {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36 })
  id: string;

  @Column({ name: 'endpoint_id', type: 'char', length: 36 })
  endpointId: string;

  @ManyToOne(() => Endpoint, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'endpoint_id', foreignKeyConstraintName: 'fk_requests_endpoint' })
  endpoint?: Endpoint;

  /** Upper-case HTTP method as received (GET, POST, ...). */
  @Column({ name: 'method', type: 'varchar', length: 16 })
  method: string;

  /** Sub-path after the endpoint id, '/' when none. */
  @Column({ name: 'path', type: 'varchar', length: 2048 })
  path: string;

  /** [name, value] pairs, duplicates and order preserved. */
  @Column({ name: 'query_params', type: 'json', nullable: true })
  queryParams: Pair[] | null;

  /** [name, value] pairs from Node's rawHeaders: case, order and duplicates preserved. */
  @Column({ name: 'headers', type: 'json' })
  headers: Pair[];

  @Column({ name: 'client_ip', type: 'varchar', length: 45, nullable: true })
  clientIp: string | null;

  /** Raw Content-Type header. */
  @Column({ name: 'content_type', type: 'varchar', length: 255, nullable: true })
  contentType: string | null;

  @Column({ name: 'content_kind', type: 'enum', enum: CONTENT_KINDS })
  contentKind: ContentKind;

  /** Raw body text; null for none, multipart and binary. */
  @Column({ name: 'body', type: 'mediumtext', nullable: true })
  body: string | null;

  /** [name, value] pairs for form and multipart (text parts only). */
  @Column({ name: 'form_fields', type: 'json', nullable: true })
  formFields: Pair[] | null;

  /** Multipart file parts that were counted and discarded. */
  @Column({ name: 'dropped_files', type: 'json', nullable: true })
  droppedFiles: DroppedFile[] | null;

  /** Bytes of the body as received, files included even when dropped. */
  @Column({ name: 'size_bytes', type: 'int', unsigned: true })
  sizeBytes: number;

  @Column({ name: 'received_at', type: 'datetime', precision: 3 })
  receivedAt: Date;

  /** Free text set by the endpoint owner (phase 8); never loaded in listings. */
  @Column({ name: 'note', type: 'text', nullable: true })
  note: string | null;
}
