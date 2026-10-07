import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { OkResponse, UserProfile } from '@yomail/shared';
import type { Session } from '../users/session.entity';
import type { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthGuard, CurrentSession, CurrentUser, OptionalAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import {
  confirmSchema,
  emailOnlySchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from './schemas';
import type {
  ConfirmBody,
  EmailOnlyBody,
  LoginBody,
  ResetPasswordBody,
  SignupBody,
} from './schemas';
import { ZodValidationPipe } from './zod-validation.pipe';

const OK: OkResponse = { ok: true };

/**
 * /api/auth/*. Bodies are JSON (express.json is mounted for this controller only,
 * see AuthModule). The throttler covers every route except logout and me.
 */
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Post('signup')
  @HttpCode(201)
  async signup(@Body(new ZodValidationPipe(signupSchema)) body: SignupBody): Promise<OkResponse> {
    await this.auth.signup(body);
    return OK;
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(
    @Body(new ZodValidationPipe(confirmSchema)) body: ConfirmBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserProfile> {
    return this.auth.confirm(body.token, req, res);
  }

  @Post('resend-confirmation')
  @HttpCode(200)
  async resend(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: EmailOnlyBody,
  ): Promise<OkResponse> {
    await this.auth.resendConfirmation(body.email);
    return OK;
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserProfile> {
    return this.auth.login(body, req, res);
  }

  @Post('logout')
  @HttpCode(204)
  @SkipThrottle()
  @UseGuards(OptionalAuthGuard)
  logout(
    @CurrentSession() session: Session | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.auth.logout(session, res);
  }

  @Get('me')
  @SkipThrottle()
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: User): UserProfile {
    return this.users.toProfile(user);
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgot(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: EmailOnlyBody,
  ): Promise<OkResponse> {
    await this.auth.forgotPassword(body.email);
    return OK;
  }

  @Post('reset-password')
  @HttpCode(204)
  reset(@Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordBody): Promise<void> {
    return this.auth.resetPassword(body.token, body.password);
  }
}
