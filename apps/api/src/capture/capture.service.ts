import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Pair } from '@yomail/shared';
import type { Env } from '../config/env';
import { EndpointsService } from '../endpoints/endpoints.service';
import { LiveEventsService } from '../live/live-events.service';
import { CapturedRequest } from '../requests/request.entity';
import { toSummary } from '../requests/request.mapper';
import { SettingsService } from '../settings/settings.service';
import type { ParsedContent } from './content';

export interface CaptureInput {
  endpointId: string;
  method: string;
  path: string;
  queryParams: Pair[] | null;
  headers: Pair[];
  clientIp: string | null;
  contentType: string | null;
  sizeBytes: number;
  content: ParsedContent;
}

@Injectable()
export class CaptureService {
  private readonly logger = new Logger(CaptureService.name);
  private readonly maxPerEndpoint: number;

  constructor(
    @InjectRepository(CapturedRequest) private readonly requests: Repository<CapturedRequest>,
    private readonly endpoints: EndpointsService,
    private readonly settings: SettingsService,
    private readonly live: LiveEventsService,
    config: ConfigService<Env, true>,
  ) {
    this.maxPerEndpoint = config.get('MAX_REQUESTS_PER_ENDPOINT', { infer: true });
  }

  /** Persists one captured request, marks the endpoint active and enforces the per-endpoint cap. */
  async store(input: CaptureInput): Promise<CapturedRequest> {
    const row = this.requests.create({
      id: randomUUID(),
      endpointId: input.endpointId,
      method: input.method,
      path: input.path,
      queryParams: input.queryParams,
      headers: input.headers,
      clientIp: input.clientIp,
      contentType: input.contentType,
      contentKind: input.content.contentKind,
      body: input.content.body,
      formFields: input.content.formFields,
      droppedFiles: input.content.droppedFiles,
      sizeBytes: input.sizeBytes,
      receivedAt: new Date(),
    });
    await this.requests.insert(row);
    await this.endpoints.touch(input.endpointId, row.receivedAt);
    await this.enforceCap(input.endpointId);
    // Fast path for subscribers on this process; other processes rely on the DB ChangeDetector.
    this.live.requestNew(toSummary(row, await this.settings.getRetentionDays()));
    return row;
  }

  /** Keeps only the newest MAX_REQUESTS_PER_ENDPOINT rows of an endpoint. */
  private async enforceCap(endpointId: string): Promise<void> {
    const count = await this.requests.count({ where: { endpointId } });
    if (count <= this.maxPerEndpoint) return;
    // MySQL forbids selecting from the target table in a DELETE subquery unless it is
    // wrapped in a derived table, hence the inner SELECT ... FROM (...) t.
    const result = (await this.requests.query(
      'DELETE FROM `requests` WHERE `endpoint_id` = ? AND `id` NOT IN (' +
        'SELECT `id` FROM (SELECT `id` FROM `requests` WHERE `endpoint_id` = ? ORDER BY `received_at` DESC LIMIT ?) t)',
      [endpointId, endpointId, this.maxPerEndpoint],
    )) as { affectedRows?: number };
    if (result.affectedRows) {
      this.logger.log(
        `endpoint ${endpointId}: dropped ${result.affectedRows} oldest request(s) (cap ${this.maxPerEndpoint})`,
      );
    }
  }
}
