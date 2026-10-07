import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Env } from '../config/env';
import { Setting } from './setting.entity';

export interface EndpointLimits {
  retentionDays: number;
  maxRequests: number;
}

export const RETENTION_DAYS_KEY = 'retention_days';
/** Retention of endpoints owned by a member (phase 8). */
export const RETENTION_DAYS_MEMBERS_KEY = 'retention_days_members';
const CACHE_TTL_MS = 60_000;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, { value: string | null; expiresAt: number }>();

  constructor(
    @InjectRepository(Setting) private readonly repo: Repository<Setting>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Raw setting lookup with a 60 s in-memory cache. Returns null when absent. */
  async get(key: string): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const row = await this.repo.findOne({ where: { key } });
    const value = row?.value ?? null;
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  /**
   * Retention in days, read from the settings table (`retention_days`, or
   * `retention_days_members` for endpoints owned by a member), falling back to the
   * matching env default when the row is missing or not a positive integer.
   */
  async getRetentionDays(owned = false): Promise<number> {
    const key = owned ? RETENTION_DAYS_MEMBERS_KEY : RETENTION_DAYS_KEY;
    const fallback = this.config.get(
      owned ? 'RETENTION_DAYS_MEMBERS_DEFAULT' : 'RETENTION_DAYS_DEFAULT',
      { infer: true },
    );
    const raw = await this.get(key);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      this.logger.warn(`settings.${key}=${raw} is invalid; using ${fallback}`);
      return fallback;
    }
    return parsed;
  }

  /** Retention and cap that apply to an endpoint, depending on whether a member owns it (phase 8.4). */
  async limitsFor(owned: boolean): Promise<EndpointLimits> {
    return {
      retentionDays: await this.getRetentionDays(owned),
      maxRequests: this.config.get(
        owned ? 'MAX_REQUESTS_PER_ENDPOINT_MEMBERS' : 'MAX_REQUESTS_PER_ENDPOINT',
        { infer: true },
      ),
    };
  }

  /** Drops the cache; useful after the purge CLI or tests change a setting. */
  invalidate(): void {
    this.cache.clear();
  }
}
