import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { SettingsModule } from '../settings/settings.module';
import { CapturedRequest } from '../requests/request.entity';
import { CaptureController } from './capture.controller';
import { CaptureService } from './capture.service';

@Module({
  imports: [TypeOrmModule.forFeature([CapturedRequest]), EndpointsModule, SettingsModule],
  controllers: [CaptureController],
  providers: [CaptureService],
  exports: [CaptureService],
})
export class CaptureModule {}
