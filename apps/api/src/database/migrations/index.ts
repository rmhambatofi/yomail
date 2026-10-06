import { InitialSchema1759650000000 } from './1759650000000-InitialSchema';
import { SeedRetentionDays1759650001000 } from './1759650001000-SeedRetentionDays';
import { PivotToWebhooks1791300000000 } from './1791300000000-PivotToWebhooks';

/**
 * Migrations are listed explicitly (no glob) so the same list works from
 * ts-node in dev and from compiled dist in production. Append new ones here.
 */
export const migrations = [
  InitialSchema1759650000000,
  SeedRetentionDays1759650001000,
  PivotToWebhooks1791300000000,
];
