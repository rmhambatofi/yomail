import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { HealthStatus } from '@yomail/shared';
import type { Env } from '../config/env';
import { SettingsService } from '../settings/settings.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly settings: SettingsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get()
  async get(): Promise<HealthStatus> {
    let db: HealthStatus['db'] = 'ok';
    let retentionDays = this.config.get('RETENTION_DAYS_DEFAULT', { infer: true });
    let retentionDaysMembers = this.config.get('RETENTION_DAYS_MEMBERS_DEFAULT', { infer: true });
    try {
      await this.dataSource.query('SELECT 1');
      [retentionDays, retentionDaysMembers] = await Promise.all([
        this.settings.getRetentionDays(false),
        this.settings.getRetentionDays(true),
      ]);
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      retention_days: retentionDays,
      retention_days_members: retentionDaysMembers,
      max_body_bytes: this.config.get('MAX_BODY_BYTES', { infer: true }),
      max_requests_per_endpoint: this.config.get('MAX_REQUESTS_PER_ENDPOINT', { infer: true }),
      max_requests_per_endpoint_members: this.config.get('MAX_REQUESTS_PER_ENDPOINT_MEMBERS', {
        infer: true,
      }),
    };
  }
}
