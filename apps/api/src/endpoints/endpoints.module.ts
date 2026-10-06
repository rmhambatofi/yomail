import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CapturedRequest } from '../requests/request.entity';
import { SettingsModule } from '../settings/settings.module';
import { Endpoint } from './endpoint.entity';
import { EndpointsController } from './endpoints.controller';
import { EndpointsService } from './endpoints.service';

@Module({
  imports: [TypeOrmModule.forFeature([Endpoint, CapturedRequest]), SettingsModule],
  controllers: [EndpointsController],
  providers: [EndpointsService],
  exports: [EndpointsService],
})
export class EndpointsModule {}
