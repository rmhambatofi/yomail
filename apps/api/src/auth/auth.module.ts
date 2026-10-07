import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { json } from 'express';
import { JSON_BODY_LIMIT } from '../common/json-body';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { AccountController } from './account.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * HTTP side of the accounts. The throttler comes from the global ThrottlingModule
 * (in-process memory, see there). EndpointsModule serves "My endpoints".
 */
@Module({
  imports: [UsersModule, MailModule, EndpointsModule],
  controllers: [AuthController, AccountController],
  providers: [AuthService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(json({ limit: JSON_BODY_LIMIT })).forRoutes(AuthController, AccountController);
  }
}
