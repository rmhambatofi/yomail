import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CaptureModule } from './capture/capture.module';
import { ThrottlingModule } from './common/throttling.module';
import { validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { EndpointsModule } from './endpoints/endpoints.module';
import { HealthModule } from './health/health.module';
import { LiveEventsModule } from './live/live-events.module';
import { LiveModule } from './live/live.module';
import { PurgeScheduleModule } from './purge/purge-schedule.module';
import { RequestsModule } from './requests/requests.module';
import { SettingsModule } from './settings/settings.module';
import { StaticModule } from './static/static.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Look for .env at the repo root first, then alongside the app (cPanel layout).
      envFilePath: ['../../.env', '.env'],
      validate: validateEnv,
    }),
    DatabaseModule,
    ThrottlingModule,
    SettingsModule,
    LiveEventsModule,
    HealthModule,
    EndpointsModule,
    RequestsModule,
    AuthModule,
    CaptureModule,
    LiveModule,
    PurgeScheduleModule,
    // Last on purpose: its GET * fallback must come after every controller route.
    StaticModule,
  ],
})
export class AppModule {}
