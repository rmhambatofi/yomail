import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EndpointDetail, EndpointSummary } from '@yomail/shared';
import type { Env } from '../config/env';
import { LiveEventsService } from '../live/live-events.service';
import { CapturedRequest } from '../requests/request.entity';
import { SettingsService } from '../settings/settings.service';
import { Endpoint } from './endpoint.entity';

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

  async create(): Promise<EndpointSummary> {
    const endpoint = this.repo.create({
      id: randomUUID(),
      createdAt: new Date(),
      lastRequestAt: null,
    });
    await this.repo.insert(endpoint);
    return {
      id: endpoint.id,
      url: this.urlFor(endpoint.id),
      created_at: endpoint.createdAt.toISOString(),
    };
  }

  async detail(id: string): Promise<EndpointDetail> {
    const endpoint = await this.repo.findOne({ where: { id } });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    const [requestCount, retentionDays] = await Promise.all([
      this.requests.count({ where: { endpointId: id } }),
      this.settings.getRetentionDays(),
    ]);
    return {
      id: endpoint.id,
      url: this.urlFor(endpoint.id),
      created_at: endpoint.createdAt.toISOString(),
      last_request_at: endpoint.lastRequestAt?.toISOString() ?? null,
      request_count: requestCount,
      retention_days: retentionDays,
    };
  }

  /** Removes the endpoint; its requests go with it (FK ON DELETE CASCADE). */
  async delete(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException('Endpoint not found');
    this.live.endpointDeleted(id);
  }

  /** Cheap existence check (primary key lookup, id column only). */
  async exists(id: string): Promise<boolean> {
    return this.repo.exist({ where: { id } });
  }

  /** Records activity so the purge keeps the endpoint alive. */
  async touch(id: string, at: Date): Promise<void> {
    await this.repo.update({ id }, { lastRequestAt: at });
  }
}
