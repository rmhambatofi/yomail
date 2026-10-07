import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { CapturedRequest } from '../requests/request.entity';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { ChangeDetector } from './change-detector.service';
import { LiveGateway } from './live.gateway';

@Module({
  // EndpointsModule: owner flag for expires_at (ChangeDetector) and the read-access check of
  // `subscribe`; UsersModule: SessionsService to resolve the handshake cookie (phase 8).
  imports: [
    TypeOrmModule.forFeature([CapturedRequest]),
    SettingsModule,
    EndpointsModule,
    UsersModule,
  ],
  providers: [LiveGateway, ChangeDetector],
})
export class LiveModule {}
