import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import type { ReplayResult, RequestDetail, RequestListResponse } from '@yomail/shared';
import { EndpointsService } from '../endpoints/endpoints.service';
import { LiveEventsService } from '../live/live-events.service';
import { SettingsService } from '../settings/settings.service';
import type { User } from '../users/user.entity';
import { ReplayService } from './replay.service';
import { CapturedRequest } from './request.entity';
import { DETAIL_COLUMNS, SUMMARY_COLUMNS, toDetail, toSummary } from './request.mapper';
import type { DetailRow, SummaryRow } from './request.mapper';

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export interface ListOptions {
  limit: number;
  /** Only rows received strictly before this instant (cursor for "Load older"). */
  before: Date | null;
}

@Injectable()
export class RequestsService {
  constructor(
    @InjectRepository(CapturedRequest) private readonly repo: Repository<CapturedRequest>,
    private readonly endpoints: EndpointsService,
    private readonly settings: SettingsService,
    private readonly live: LiveEventsService,
    private readonly replayer: ReplayService,
  ) {}

  /** Newest first. Fetches limit + 1 rows to report has_more without a COUNT. */
  async list(
    endpointId: string,
    options: ListOptions,
    user: User | null = null,
  ): Promise<RequestListResponse> {
    const retentionDays = await this.retentionOf(endpointId, user);
    const where: FindOptionsWhere<CapturedRequest> = { endpointId };
    if (options.before) where.receivedAt = LessThan(options.before);
    const rows = (await this.repo.find({
      select: [...SUMMARY_COLUMNS],
      where,
      order: { receivedAt: 'DESC' },
      take: options.limit + 1,
    })) as SummaryRow[];
    const page = rows.slice(0, options.limit);
    return {
      endpoint_id: endpointId,
      retention_days: retentionDays,
      requests: page.map((row) => toSummary(row, retentionDays)),
      has_more: rows.length > options.limit,
    };
  }

  /** 404 when the request does not exist OR belongs to another endpoint. */
  async detail(endpointId: string, id: string, user: User | null = null): Promise<RequestDetail> {
    const retentionDays = await this.retentionOf(endpointId, user);
    const row = (await this.repo.findOne({
      select: [...DETAIL_COLUMNS],
      where: { id, endpointId },
    })) as DetailRow | null;
    if (!row) throw new NotFoundException('Request not found');
    return toDetail(row, retentionDays);
  }

  /** Owner only (phase 8.3). `null` removes the note. */
  async updateNote(
    endpointId: string,
    id: string,
    user: User,
    note: string | null,
  ): Promise<RequestDetail> {
    await this.endpoints.loadOwned(endpointId, user);
    const result = await this.repo.update({ id, endpointId }, { note });
    if (!result.affected) throw new NotFoundException('Request not found');
    return this.detail(endpointId, id, user);
  }

  /** Owner only (phase 8.3): re-send the stored request to `targetUrl` (see ReplayService). */
  async replay(
    endpointId: string,
    id: string,
    user: User,
    targetUrl: string,
  ): Promise<ReplayResult> {
    await this.endpoints.loadOwned(endpointId, user);
    const target = this.replayer.validateTarget(targetUrl);
    const row = (await this.repo.findOne({
      select: [...DETAIL_COLUMNS],
      where: { id, endpointId },
    })) as DetailRow | null;
    if (!row) throw new NotFoundException('Request not found');
    return this.replayer.replay(row, target);
  }

  async delete(endpointId: string, id: string, user: User | null = null): Promise<void> {
    await this.endpoints.assertReadable(endpointId, user);
    const result = await this.repo.delete({ id, endpointId });
    if (!result.affected) throw new NotFoundException('Request not found');
    this.live.requestDeleted(endpointId, id);
  }

  /** Empties the inbox; the endpoint itself stays. */
  async clear(endpointId: string, user: User | null = null): Promise<void> {
    await this.endpoints.assertReadable(endpointId, user);
    await this.repo.delete({ endpointId });
    this.live.endpointCleared(endpointId);
  }

  /**
   * Read-access check (404 unknown, 401/403 on an owned endpoint for a non-owner), then the
   * retention that applies (members' value for owned endpoints).
   */
  private async retentionOf(endpointId: string, user: User | null): Promise<number> {
    const { owned } = await this.endpoints.assertReadable(endpointId, user);
    return this.settings.getRetentionDays(owned);
  }
}
