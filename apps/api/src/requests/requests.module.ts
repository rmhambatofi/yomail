import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { json } from 'express';
import { JSON_BODY_LIMIT } from '../common/json-body';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { SettingsModule } from '../settings/settings.module';
import { UsersModule } from '../users/users.module';
import { ReplayService } from './replay.service';
import { CapturedRequest } from './request.entity';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  // UsersModule provides SessionsService to AuthGuard (note and replay routes).
  imports: [
    TypeOrmModule.forFeature([CapturedRequest]),
    EndpointsModule,
    SettingsModule,
    UsersModule,
  ],
  controllers: [RequestsController],
  providers: [RequestsService, ReplayService],
  exports: [RequestsService],
})
export class RequestsModule implements NestModule {
  /** Note and replay bodies are small JSON documents; the app itself has no body parser. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(json({ limit: JSON_BODY_LIMIT })).forRoutes(RequestsController);
  }
}
