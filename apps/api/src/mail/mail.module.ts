import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { json } from 'express';
import { JSON_BODY_LIMIT_LARGE } from '../common/json-body';
import { UsersModule } from '../users/users.module';
import { CaughtMail } from './caught-mail.entity';
import { DevMailCatcherController } from './dev-mail-catcher.controller';
import { DevMailboxService } from './dev-mailbox.service';
import { MailService } from './mail.service';

/**
 * Outgoing email (SMTP in production, the dev mail catcher everywhere else) and the
 * catcher itself (/devmailcatcher, admin-only, DB-backed, available in every
 * environment so other applications can push their emails to it). ConfigModule is
 * global; UsersModule provides SessionsService to the catcher's AuthGuard.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CaughtMail]), UsersModule],
  controllers: [DevMailCatcherController],
  providers: [MailService, DevMailboxService],
  exports: [MailService],
})
export class MailModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // POST /devmailcatcher/messages.json carries a whole email (text + HTML).
    consumer.apply(json({ limit: JSON_BODY_LIMIT_LARGE })).forRoutes(DevMailCatcherController);
  }
}
