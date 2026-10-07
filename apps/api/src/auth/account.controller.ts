import { Body, Controller, Delete, Get, HttpCode, Patch, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AccountEndpointsResponse } from '@yomail/shared';
import { EndpointsService } from '../endpoints/endpoints.service';
import type { Session } from '../users/session.entity';
import type { User } from '../users/user.entity';
import { AuthGuard, CurrentSession, CurrentUser } from './auth.guard';
import { AuthService } from './auth.service';
import { changePasswordSchema, deleteAccountSchema } from './schemas';
import type { ChangePasswordBody, DeleteAccountBody } from './schemas';
import { ZodValidationPipe } from './zod-validation.pipe';

/** /api/account: signed-in user only. */
@Controller('account')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly endpoints: EndpointsService,
  ) {}

  /** "My endpoints" (phase 8): the endpoints created or claimed by the signed-in user. */
  @Get('endpoints')
  async myEndpoints(@CurrentUser() user: User): Promise<AccountEndpointsResponse> {
    return { endpoints: await this.endpoints.listOwned(user) };
  }

  @Patch('password')
  @HttpCode(204)
  changePassword(
    @CurrentUser() user: User,
    @CurrentSession() session: Session,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordBody,
  ): Promise<void> {
    return this.auth.changePassword(user, session, body);
  }

  @Delete()
  @HttpCode(204)
  deleteAccount(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(deleteAccountSchema)) body: DeleteAccountBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.auth.deleteAccount(user, body.password, res);
  }
}
