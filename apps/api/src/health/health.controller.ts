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
    try {
      await this.dataSource.query('SELECT 1');
      retentionDays = await this.settings.getRetentionDays();
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      retention_days: retentionDays,
      max_body_bytes: this.config.get('MAX_BODY_BYTES', { infer: true }),
    };
  }
}
