import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import type { RequestDetail, RequestListResponse } from '@yomail/shared';
import { EndpointsService } from '../endpoints/endpoints.service';
import { LiveEventsService } from '../live/live-events.service';
import { SettingsService } from '../settings/settings.service';
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
  ) {}

  /** Newest first. Fetches limit + 1 rows to report has_more without a COUNT. */
  async list(endpointId: string, options: ListOptions): Promise<RequestListResponse> {
    await this.assertEndpoint(endpointId);
    const retentionDays = await this.settings.getRetentionDays();
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
  async detail(endpointId: string, id: string): Promise<RequestDetail> {
    await this.assertEndpoint(endpointId);
    const row = (await this.repo.findOne({
      select: [...DETAIL_COLUMNS],
      where: { id, endpointId },
    })) as DetailRow | null;
    if (!row) throw new NotFoundException('Request not found');
    return toDetail(row, await this.settings.getRetentionDays());
  }

  async delete(endpointId: string, id: string): Promise<void> {
    await this.assertEndpoint(endpointId);
    const result = await this.repo.delete({ id, endpointId });
    if (!result.affected) throw new NotFoundException('Request not found');
    this.live.requestDeleted(endpointId, id);
  }

  /** Empties the inbox; the endpoint itself stays. */
  async clear(endpointId: string): Promise<void> {
    await this.assertEndpoint(endpointId);
    await this.repo.delete({ endpointId });
    this.live.endpointCleared(endpointId);
  }

  private async assertEndpoint(endpointId: string): Promise<void> {
    if (!(await this.endpoints.exists(endpointId))) {
      throw new NotFoundException('Endpoint not found');
    }
  }
}
