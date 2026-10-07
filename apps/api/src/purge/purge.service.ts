import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Env } from '../config/env';
import { SettingsService } from '../settings/settings.service';

export const PURGE_BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeReport {
  /** Retention of anonymous endpoints */
  retentionDays: number;
  /** Retention of endpoints owned by a member (phase 8.4) */
  retentionDaysMembers: number;
  /** Anonymous requests received strictly before this instant are expired */
  cutoff: Date;
  /** Same for requests of owned endpoints */
  cutoffMembers: Date;
  /** Expired requests deleted (or counted in dry-run mode) */
  deleted: number;
  /** Idle endpoints deleted (or counted in dry-run mode) */
  endpointsDeleted: number;
  batches: number;
  /** Expired login sessions */
  sessionsDeleted: number;
  /** Expired or already used email tokens */
  tokensDeleted: number;
  /** Accounts never confirmed, created before userCutoff */
  usersDeleted: number;
  unconfirmedUserTtlDays: number;
  userCutoff: Date;
  dryRun: boolean;
}

/**
 * Deletes expired requests, then endpoints idle for longer than the retention.
 * Expiry is never stored: a request is expired when
 * received_at < now - settings.retention_days, so changing the setting applies
 * to every row immediately. An endpoint is idle when
 * COALESCE(last_request_at, created_at) < cutoff. Request deletes run in
 * batches of PURGE_BATCH_SIZE to keep lock time short on shared MySQL.
 * Phase 7 adds expired sessions, used or expired email tokens, and accounts
 * never confirmed within UNCONFIRMED_USER_TTL_DAYS (hard delete, so the email
 * becomes available again; sessions and tokens cascade, endpoints keep
 * running with owner_id set to NULL by the FK).
 */
@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);
  private running = false;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly settings: SettingsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async run(options: { dryRun?: boolean } = {}): Promise<PurgeReport> {
    if (this.running) {
      this.logger.warn('purge already running, skipping this invocation');
      return {
        retentionDays: 0,
        retentionDaysMembers: 0,
        cutoff: new Date(),
        cutoffMembers: new Date(),
        deleted: 0,
        endpointsDeleted: 0,
        batches: 0,
        sessionsDeleted: 0,
        tokensDeleted: 0,
        usersDeleted: 0,
        unconfirmedUserTtlDays: 0,
        userCutoff: new Date(),
        dryRun: !!options.dryRun,
      };
    }
    this.running = true;
    try {
      this.settings.invalidate();
      const retentionDays = await this.settings.getRetentionDays(false);
      const retentionDaysMembers = await this.settings.getRetentionDays(true);
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
      const cutoffMembers = new Date(Date.now() - retentionDaysMembers * DAY_MS);
      const retention = { retentionDays, retentionDaysMembers, cutoff, cutoffMembers };
      const unconfirmedUserTtlDays = this.config.get('UNCONFIRMED_USER_TTL_DAYS', { infer: true });
      const now = new Date();
      const userCutoff = new Date(now.getTime() - unconfirmedUserTtlDays * DAY_MS);
      const dryRun = !!options.dryRun;
      const accounts = { unconfirmedUserTtlDays, userCutoff };

      if (dryRun) {
        const deleted =
          (await this.count(SQL.countRequests(false), cutoff)) +
          (await this.count(SQL.countRequests(true), cutoffMembers));
        const endpointsDeleted =
          (await this.count(SQL.countEndpoints(false), cutoff)) +
          (await this.count(SQL.countEndpoints(true), cutoffMembers));
        const sessionsDeleted = await this.count(SQL.countSessions, now);
        const tokensDeleted = await this.count(SQL.countTokens, now);
        const usersDeleted = await this.count(SQL.countUsers, userCutoff);
        this.logger.log(
          `dry run: ${deleted} request(s) and ${endpointsDeleted} idle endpoint(s) older than ${cutoff.toISOString()} (${retentionDays} days; members ${retentionDaysMembers} days); ` +
            `${sessionsDeleted} expired session(s), ${tokensDeleted} stale token(s), ${usersDeleted} unconfirmed account(s) older than ${userCutoff.toISOString()} (${unconfirmedUserTtlDays} days)`,
        );
        return {
          ...retention,
          deleted,
          endpointsDeleted,
          batches: 0,
          sessionsDeleted,
          tokensDeleted,
          usersDeleted,
          ...accounts,
          dryRun,
        };
      }

      let deleted = 0;
      let batches = 0;
      for (const [owned, at] of [
        [false, cutoff],
        [true, cutoffMembers],
      ] as const) {
        for (;;) {
          const affected = await this.deleteRequestBatch(owned, at);
          batches += 1;
          deleted += affected;
          if (affected < PURGE_BATCH_SIZE) break;
        }
      }
      const endpointsDeleted =
        (await this.affected(SQL.deleteEndpoints(false), [cutoff])) +
        (await this.affected(SQL.deleteEndpoints(true), [cutoffMembers]));
      const sessionsDeleted = await this.affected(SQL.deleteSessions, [now]);
      const tokensDeleted = await this.affected(SQL.deleteTokens, [now]);
      const usersDeleted = await this.affected(SQL.deleteUsers, [userCutoff]);
      this.logger.log(
        `purged ${deleted} request(s) in ${batches} batch(es) and ${endpointsDeleted} idle endpoint(s) older than ${cutoff.toISOString()} (${retentionDays} days; members ${retentionDaysMembers} days); ` +
          `${sessionsDeleted} expired session(s), ${tokensDeleted} stale token(s), ${usersDeleted} unconfirmed account(s) older than ${userCutoff.toISOString()} (${unconfirmedUserTtlDays} days)`,
      );
      return {
        ...retention,
        deleted,
        endpointsDeleted,
        batches,
        sessionsDeleted,
        tokensDeleted,
        usersDeleted,
        ...accounts,
        dryRun,
      };
    } finally {
      this.running = false;
    }
  }

  /** MySQL supports DELETE ... LIMIT; TypeORM's delete() does not, so use raw SQL. */
  private deleteRequestBatch(owned: boolean, cutoff: Date): Promise<number> {
    return this.affected(
      `DELETE FROM \`requests\` WHERE \`received_at\` < ? AND ${SQL.endpointFilter(owned)} ORDER BY \`received_at\` LIMIT ?`,
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

/** Housekeeping statements; each takes exactly one date parameter. */
const SQL = {
  /** Requests of anonymous (owner NULL) or owned endpoints; a subquery on another table is allowed in DELETE. */
  endpointFilter: (owned: boolean) =>
    `\`endpoint_id\` IN (SELECT \`id\` FROM \`endpoints\` WHERE \`owner_id\` IS ${owned ? 'NOT NULL' : 'NULL'})`,
  countRequests: (owned: boolean) =>
    `SELECT COUNT(*) AS n FROM \`requests\` WHERE \`received_at\` < ? AND ${SQL.endpointFilter(owned)}`,
  countEndpoints: (owned: boolean) =>
    `SELECT COUNT(*) AS n FROM \`endpoints\` WHERE COALESCE(\`last_request_at\`, \`created_at\`) < ? AND \`owner_id\` IS ${owned ? 'NOT NULL' : 'NULL'}`,
  deleteEndpoints: (owned: boolean) =>
    `DELETE FROM \`endpoints\` WHERE COALESCE(\`last_request_at\`, \`created_at\`) < ? AND \`owner_id\` IS ${owned ? 'NOT NULL' : 'NULL'}`,
  countSessions: 'SELECT COUNT(*) AS n FROM `sessions` WHERE `expires_at` < ?',
  deleteSessions: 'DELETE FROM `sessions` WHERE `expires_at` < ?',
  countTokens:
    'SELECT COUNT(*) AS n FROM `user_tokens` WHERE `expires_at` < ? OR `used_at` IS NOT NULL',
  deleteTokens: 'DELETE FROM `user_tokens` WHERE `expires_at` < ? OR `used_at` IS NOT NULL',
  countUsers:
    "SELECT COUNT(*) AS n FROM `users` WHERE `status` = 'DISABLED' AND `enabled_at` IS NULL AND `created_at` < ?",
  deleteUsers:
    "DELETE FROM `users` WHERE `status` = 'DISABLED' AND `enabled_at` IS NULL AND `created_at` < ?",
} as const;
