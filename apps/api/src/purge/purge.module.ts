import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { PurgeService } from './purge.service';

/** Purge logic only; the hourly cron lives in PurgeScheduleModule so the CLI can skip it. */
@Module({
  imports: [SettingsModule],
  providers: [PurgeService],
  exports: [PurgeService],
})
export class PurgeModule {}
