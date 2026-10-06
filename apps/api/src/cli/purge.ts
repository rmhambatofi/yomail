import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { PurgeModule } from '../purge/purge.module';
import { PurgeService } from '../purge/purge.service';

/**
 * CLI entry for the cPanel cron (compiled to dist/cli/purge.js):
 *   0 * * * * cd ~/yomail/apps/api && ~/nodevenv/.../bin/node dist/cli/purge.js >> ~/logs/yomail-purge.log 2>&1
 * Flags: --dry-run (count only), --quiet (errors only).
 * Boots a Nest application context without HTTP and without the in-process scheduler.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    DatabaseModule,
    PurgeModule,
  ],
})
class PurgeCliModule {}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const quiet = args.has('--quiet');

  const app = await NestFactory.createApplicationContext(PurgeCliModule, {
    logger: quiet ? ['error'] : ['log', 'warn', 'error'],
  });
  try {
    const report = await app.get(PurgeService).run({ dryRun });
    const line =
      `${new Date().toISOString()} ${dryRun ? 'would delete' : 'deleted'} ${report.deleted} request(s), ` +
      `${report.endpointsDeleted} idle endpoint(s) (retention ${report.retentionDays} d, cutoff ${report.cutoff.toISOString()}, ${report.batches} batch(es))`;
    if (!quiet) Logger.log(line, 'purge-cli');
    return 0;
  } catch (err) {
    Logger.error(`purge failed: ${(err as Error).stack ?? err}`, 'purge-cli');
    return 1;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
