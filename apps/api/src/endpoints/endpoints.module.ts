import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { json } from 'express';
import { JSON_BODY_LIMIT_LARGE } from '../common/json-body';
import { CapturedRequest } from '../requests/request.entity';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { Endpoint } from './endpoint.entity';
import { EndpointsController } from './endpoints.controller';
import { EndpointsService } from './endpoints.service';

@Module({
  // UsersModule provides SessionsService to the auth guards.
  imports: [TypeOrmModule.forFeature([Endpoint, CapturedRequest]), SettingsModule, UsersModule],
  controllers: [EndpointsController],
  providers: [EndpointsService],
  exports: [EndpointsService],
})
export class EndpointsModule implements NestModule {
  /** PATCH bodies (name, response config up to 64 KB) are JSON; the app itself has no body parser. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(json({ limit: JSON_BODY_LIMIT_LARGE })).forRoutes(EndpointsController);
  }
}
