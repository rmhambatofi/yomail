import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { HealthController } from './health.controller';

@Module({ imports: [SettingsModule], controllers: [HealthController] })
export class HealthModule {}
