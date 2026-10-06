import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { SettingsModule } from '../settings/settings.module';
import { CapturedRequest } from './request.entity';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  imports: [TypeOrmModule.forFeature([CapturedRequest]), EndpointsModule, SettingsModule],
  controllers: [RequestsController],
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
