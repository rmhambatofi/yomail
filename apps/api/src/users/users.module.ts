import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PasswordService } from './password.service';
import { Session } from './session.entity';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';
import { UserToken } from './user-token.entity';
import { User } from './user.entity';
import { UsersService } from './users.service';

/**
 * Accounts, sessions and email tokens. No HTTP here: AuthModule exposes the
 * routes, the CLI (cli/user.ts) and any module needing the auth guards import
 * this one.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Session, UserToken])],
  providers: [UsersService, PasswordService, SessionsService, TokensService],
  exports: [UsersService, PasswordService, SessionsService, TokensService],
})
export class UsersModule {}
