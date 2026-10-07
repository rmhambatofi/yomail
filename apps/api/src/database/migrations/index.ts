import { InitialSchema1759650000000 } from './1759650000000-InitialSchema';
import { SeedRetentionDays1759650001000 } from './1759650001000-SeedRetentionDays';
import { PivotToWebhooks1791300000000 } from './1791300000000-PivotToWebhooks';
import { AddUsers1791400000000 } from './1791400000000-AddUsers';
import { AddMemberFeatures1791500000000 } from './1791500000000-AddMemberFeatures';
import { AddCaughtMails1791600000000 } from './1791600000000-AddCaughtMails';

/**
 * Migrations are listed explicitly (no glob) so the same list works from
 * ts-node in dev and from compiled dist in production. Append new ones here.
 */
export const migrations = [
  InitialSchema1759650000000,
  SeedRetentionDays1759650001000,
  PivotToWebhooks1791300000000,
  AddUsers1791400000000,
  AddMemberFeatures1791500000000,
  AddCaughtMails1791600000000,
];
