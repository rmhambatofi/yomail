import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PurgeModule } from './purge.module';
import { PurgeScheduler } from './purge.scheduler';

@Module({
  imports: [ScheduleModule.forRoot(), PurgeModule],
  providers: [PurgeScheduler],
})
export class PurgeScheduleModule {}
