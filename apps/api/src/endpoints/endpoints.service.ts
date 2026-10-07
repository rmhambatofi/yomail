import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  EndpointDetail,
  EndpointSummary,
  OwnedEndpointSummary,
  ResponseConfig,
} from '@yomail/shared';
import { authError } from '../auth/auth-error';
import type { Env } from '../config/env';
import { LiveEventsService } from '../live/live-events.service';
import { CapturedRequest } from '../requests/request.entity';
import { SettingsService } from '../settings/settings.service';
import type { User } from '../users/user.entity';
import { Endpoint } from './endpoint.entity';
import type { UpdateEndpointBody } from './schemas';

/** What the capture path needs, fetched in one primary-key lookup. */
export interface CaptureTarget {
  id: string;
  ownerId: string | null;
  responseConfig: ResponseConfig | null;
}

const OWNED_LIST_LIMIT = 200;

interface OwnedRow {
  id: string;
  name: string | null;
  created_at: Date;
  last_request_at: Date | null;
  request_count: number | string;
}

@Injectable()
export class EndpointsService {
  constructor(
    @InjectRepository(Endpoint) private readonly repo: Repository<Endpoint>,
    @InjectRepository(CapturedRequest) private readonly requests: Repository<CapturedRequest>,
    private readonly settings: SettingsService,
    private readonly live: LiveEventsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Public capture URL for an endpoint id. */
  urlFor(id: string): string {
    return `${this.config.get('PUBLIC_BASE_URL', { infer: true })}/${id}`;
  }

  /** `ownerId` is set when the caller has a valid session (phase 7); anonymous otherwise. */
  async create(ownerId: string | null = null): Promise<EndpointSummary> {
    const endpoint = this.repo.create({
      id: randomUUID(),
      createdAt: new Date(),
      lastRequestAt: null,
      ownerId,
      name: null,
      responseConfig: null,
    });
    await this.repo.insert(endpoint);
    return {
      id: endpoint.id,
      url: this.urlFor(endpoint.id),
      created_at: endpoint.createdAt.toISOString(),
    };
  }

  /** Detail for a reader allowed to see the endpoint (see `loadReadable`). */
  async detail(id: string, user: User | null = null): Promise<EndpointDetail> {
    const endpoint = await this.loadReadable(id, user);
    return this.toDetail(endpoint, user);
  }

  /** "My endpoints": most recently active first (phase 8). */
  async listOwned(user: User): Promise<OwnedEndpointSummary[]> {
    const rows = (await this.repo.query(
      'SELECT e.`id`, e.`name`, e.`created_at`, e.`last_request_at`, ' +
        '(SELECT COUNT(*) FROM `requests` r WHERE r.`endpoint_id` = e.`id`) AS `request_count` ' +
        'FROM `endpoints` e WHERE e.`owner_id` = ? ' +
        'ORDER BY COALESCE(e.`last_request_at`, e.`created_at`) DESC LIMIT ?',
      [user.id, OWNED_LIST_LIMIT],
    )) as OwnedRow[];
    return rows.map((row) => ({
      id: row.id,
      url: this.urlFor(row.id),
      name: row.name,
      created_at: row.created_at.toISOString(),
      last_request_at: row.last_request_at?.toISOString() ?? null,
      request_count: Number(row.request_count),
    }));
  }

  /** Owner only: rename and/or configure the response. Absent fields stay as they are. */
  async update(id: string, user: User, body: UpdateEndpointBody): Promise<EndpointDetail> {
    const endpoint = await this.loadOwned(id, user);
    const patch: Partial<Endpoint> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.response !== undefined) patch.responseConfig = body.response;
    await this.repo.update({ id }, patch);
    return this.toDetail({ ...endpoint, ...patch }, user);
  }

  /** A member takes an ownerless endpoint; an endpoint that already has an owner is refused. */
  async claim(id: string, user: User): Promise<EndpointDetail> {
    const endpoint = await this.repo.findOne({ where: { id } });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    if (endpoint.ownerId !== null) throw authError.notOwner();
    // Conditional update: two members claiming at once cannot both win.
    const result = await this.repo
      .createQueryBuilder()
      .update(Endpoint)
      .set({ ownerId: user.id })
      .where('id = :id AND owner_id IS NULL', { id })
      .execute();
    if (!result.affected) throw authError.notOwner();
    endpoint.ownerId = user.id;
    // The inbox is private from now on: live subscribers must re-check their access.
    this.live.endpointClaimed(id);
    return this.toDetail(endpoint, user);
  }

  /**
   * Removes the endpoint; its requests go with it (FK ON DELETE CASCADE).
   * Anyone may delete an ownerless endpoint (the UUID is the key); an owned one needs
   * its owner: 401 without a session, 403 NOT_OWNER for another member.
   */
  async delete(id: string, user: User | null = null): Promise<void> {
    await this.assertReadable(id, user);
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException('Endpoint not found');
    this.live.endpointDeleted(id);
  }

  /** Cheap existence check (primary key lookup, id column only). */
  async exists(id: string): Promise<boolean> {
    return this.repo.exist({ where: { id } });
  }

  /** `null` when unknown; otherwise whether a member owns it (drives retention and cap, phase 8.4). */
  async isOwned(id: string): Promise<boolean | null> {
    const row = await this.repo.findOne({ select: ['id', 'ownerId'], where: { id } });
    return row ? row.ownerId !== null : null;
  }

  /** Owner flag of several endpoints at once (ChangeDetector). Unknown ids are left out. */
  async ownedMap(ids: string[]): Promise<Map<string, boolean>> {
    if (ids.length === 0) return new Map();
    const rows = await this.repo.find({ select: ['id', 'ownerId'], where: { id: In(ids) } });
    return new Map(rows.map((r) => [r.id, r.ownerId !== null]));
  }

  /** Existence check plus what the capture needs to answer (one query). */
  async findForCapture(id: string): Promise<CaptureTarget | null> {
    const row = await this.repo.findOne({
      select: ['id', 'ownerId', 'responseConfig'],
      where: { id },
    });
    return row ? { id: row.id, ownerId: row.ownerId, responseConfig: row.responseConfig } : null;
  }

  /** Records activity so the purge keeps the endpoint alive. */
  async touch(id: string, at: Date): Promise<void> {
    await this.repo.update({ id }, { lastRequestAt: at });
  }

  /**
   * Read access (phase 8): an ownerless endpoint is readable by whoever knows the UUID;
   * an owned endpoint only by its owner. 404 when unknown, 401 UNAUTHENTICATED without a
   * session on an owned endpoint, 403 NOT_OWNER for another member.
   */
  async loadReadable(id: string, user: User | null): Promise<Endpoint> {
    const endpoint = await this.repo.findOne({ where: { id } });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    assertReadable(endpoint.ownerId, user);
    return endpoint;
  }

  /** Same rule as `loadReadable` on the owner column only; returns whether a member owns it. */
  async assertReadable(id: string, user: User | null): Promise<{ owned: boolean }> {
    const row = await this.repo.findOne({ select: ['id', 'ownerId'], where: { id } });
    if (!row) throw new NotFoundException('Endpoint not found');
    assertReadable(row.ownerId, user);
    return { owned: row.ownerId !== null };
  }

  /** 404 when unknown, 403 NOT_OWNER unless `user` owns it. */
  async loadOwned(id: string, user: User): Promise<Endpoint> {
    const endpoint = await this.repo.findOne({ where: { id } });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    if (endpoint.ownerId !== user.id) throw authError.notOwner();
    return endpoint;
  }

  private async toDetail(endpoint: Endpoint, user: User | null): Promise<EndpointDetail> {
    const owned = user !== null && endpoint.ownerId === user.id;
    const [requestCount, limits] = await Promise.all([
      this.requests.count({ where: { endpointId: endpoint.id } }),
      this.settings.limitsFor(endpoint.ownerId !== null),
    ]);
    return {
      id: endpoint.id,
      url: this.urlFor(endpoint.id),
      created_at: endpoint.createdAt.toISOString(),
      last_request_at: endpoint.lastRequestAt?.toISOString() ?? null,
      request_count: requestCount,
      retention_days: limits.retentionDays,
      max_requests: limits.maxRequests,
      name: endpoint.name,
      has_owner: endpoint.ownerId !== null,
      owned,
      custom_response: endpoint.responseConfig !== null,
      response: owned ? endpoint.responseConfig : null,
    };
  }
}

/** Owned endpoints are private to their owner; ownerless ones are open to any reader. */
function assertReadable(ownerId: string | null, user: User | null): void {
  if (ownerId === null) return;
  if (!user) throw authError.unauthenticated();
  if (ownerId !== user.id) throw authError.notOwner();
}
