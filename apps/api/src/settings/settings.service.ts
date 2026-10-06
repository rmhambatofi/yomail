import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Env } from '../config/env';
import { Setting } from './setting.entity';

export const RETENTION_DAYS_KEY = 'retention_days';
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
   * Retention in days, read from the settings table, falling back to
   * RETENTION_DAYS_DEFAULT when the row is missing or not a positive integer.
   */
  async getRetentionDays(): Promise<number> {
    const fallback = this.config.get('RETENTION_DAYS_DEFAULT', { infer: true });
    const raw = await this.get(RETENTION_DAYS_KEY);
    if (raw === null) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      this.logger.warn(`settings.${RETENTION_DAYS_KEY}=${raw} is invalid; using ${fallback}`);
      return fallback;
    }
    return parsed;
  }

  /** Drops the cache; useful after the purge CLI or tests change a setting. */
  invalidate(): void {
    this.cache.clear();
  }
}
