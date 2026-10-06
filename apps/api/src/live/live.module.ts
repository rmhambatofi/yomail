import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CapturedRequest } from '../requests/request.entity';
import { SettingsModule } from '../settings/settings.module';
import { ChangeDetector } from './change-detector.service';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [TypeOrmModule.forFeature([CapturedRequest]), SettingsModule],
  providers: [LiveGateway, ChangeDetector],
})
export class LiveModule {}
