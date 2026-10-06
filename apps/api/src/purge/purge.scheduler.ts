import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PurgeService } from './purge.service';

/**
 * In-process hourly purge. This is only a backup: Passenger may put the app to
 * sleep, so the cPanel cron running `npm run purge` is the source of truth.
 */
@Injectable()
export class PurgeScheduler {
  private readonly logger = new Logger(PurgeScheduler.name);

  constructor(private readonly purge: PurgeService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'purge-expired-requests' })
  async hourly(): Promise<void> {
    try {
      await this.purge.run();
    } catch (err) {
      this.logger.error(`scheduled purge failed: ${(err as Error).message}`);
    }
  }
}
