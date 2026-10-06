import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';

export const PURGE_BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeReport {
  retentionDays: number;
  /** Requests received strictly before this instant are expired */
  cutoff: Date;
  /** Expired requests deleted (or counted in dry-run mode) */
  deleted: number;
  /** Idle endpoints deleted (or counted in dry-run mode) */
  endpointsDeleted: number;
  batches: number;
  dryRun: boolean;
}

/**
 * Deletes expired requests, then endpoints idle for longer than the retention.
 * Expiry is never stored: a request is expired when
 * received_at < now - settings.retention_days, so changing the setting applies
 * to every row immediately. An endpoint is idle when
 * COALESCE(last_request_at, created_at) < cutoff. Request deletes run in
 * batches of PURGE_BATCH_SIZE to keep lock time short on shared MySQL.
 */
@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async run(options: { dryRun?: boolean } = {}): Promise<PurgeReport> {
    if (this.running) {
      this.logger.warn('purge already running, skipping this invocation');
      return {
        retentionDays: 0,
        cutoff: new Date(),
        deleted: 0,
        endpointsDeleted: 0,
        batches: 0,
        dryRun: !!options.dryRun,
      };
    }
    this.running = true;
    try {
      this.settings.invalidate();
      const retentionDays = await this.settings.getRetentionDays();
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
      const dryRun = !!options.dryRun;

      if (dryRun) {
        const deleted = await this.count(
          'SELECT COUNT(*) AS n FROM `requests` WHERE `received_at` < ?',
          cutoff,
        );
        const endpointsDeleted = await this.count(
          'SELECT COUNT(*) AS n FROM `endpoints` WHERE COALESCE(`last_request_at`, `created_at`) < ?',
          cutoff,
        );
        this.logger.log(
          `dry run: ${deleted} request(s) and ${endpointsDeleted} idle endpoint(s) older than ${cutoff.toISOString()} (${retentionDays} days)`,
        );
        return { retentionDays, cutoff, deleted, endpointsDeleted, batches: 0, dryRun };
      }

      let deleted = 0;
      let batches = 0;
      for (;;) {
        const affected = await this.deleteRequestBatch(cutoff);
        batches += 1;
        deleted += affected;
        if (affected < PURGE_BATCH_SIZE) break;
      }
      const endpointsDeleted = await this.affected(
        'DELETE FROM `endpoints` WHERE COALESCE(`last_request_at`, `created_at`) < ?',
        [cutoff],
      );
      this.logger.log(
        `purged ${deleted} request(s) in ${batches} batch(es) and ${endpointsDeleted} idle endpoint(s) older than ${cutoff.toISOString()} (${retentionDays} days)`,
      );
      return { retentionDays, cutoff, deleted, endpointsDeleted, batches, dryRun };
    } finally {
      this.running = false;
    }
  }

  /** MySQL supports DELETE ... LIMIT; TypeORM's delete() does not, so use raw SQL. */
  private deleteRequestBatch(cutoff: Date): Promise<number> {
    return this.affected(
      'DELETE FROM `requests` WHERE `received_at` < ? ORDER BY `received_at` LIMIT ?',
      [cutoff, PURGE_BATCH_SIZE],
    );
  }

  private async affected(sql: string, params: unknown[]): Promise<number> {
    const result = (await this.db.query(sql, params)) as { affectedRows?: number };
    return result.affectedRows ?? 0;
  }

  private async count(sql: string, cutoff: Date): Promise<number> {
    const rows = (await this.db.query(sql, [cutoff])) as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  }
}
