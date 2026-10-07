import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { UserProfile } from '@yomail/shared';
import type { Env } from '../config/env';
import { isProduction } from '../config/env';
import { MailService } from '../mail/mail.service';
import { confirmEmail, resetPassword } from '../mail/templates';
import type { Session } from '../users/session.entity';
import { SessionsService } from '../users/sessions.service';
import { TokensService } from '../users/tokens.service';
import type { User } from '../users/user.entity';
import { DuplicateUserError, UsersService } from '../users/users.service';
import { authError } from './auth-error';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

/**
 * Sign-up, confirmation, login and account flows. Controllers stay thin; this
 * service owns the status rules (DISABLED / ENABLED / DELETED) and the cookie.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly publicBaseUrl: string;
  private readonly secureCookie: boolean;

  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.publicBaseUrl = config.get('PUBLIC_BASE_URL', { infer: true });
    this.secureCookie = isProduction(config.get('NODE_ENV', { infer: true }));
  }

  /** Creates a DISABLED standard user and emails the activation link. */
  async signup(input: { username: string; email: string; password: string }): Promise<void> {
    let user: User;
    try {
      user = await this.users.create({ ...input, role: 'STANDARD', status: 'DISABLED' });
    } catch (err) {
      if (err instanceof DuplicateUserError) {
        throw err.field === 'email' ? authError.emailTaken() : authError.usernameTaken();
      }
      throw err;
    }
    await this.sendConfirmation(user);
  }

  /** Activates the account and opens a session (the user lands signed in). */
  async confirm(token: string, req: Request, res: Response): Promise<UserProfile> {
    const user = await this.tokens.consume(token, 'CONFIRM_EMAIL');
    if (!user || user.status !== 'DISABLED') throw authError.tokenInvalid();
    await this.users.enable(user);
    await this.users.markLogin(user);
    await this.openSession(user, req, res);
    return this.users.toProfile(user);
  }

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async resendConfirmation(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (user && user.status === 'DISABLED') {
      await this.sendConfirmation(user);
    } else {
      // Silent for the caller (no enumeration); explicit in the server log for whoever tests this.
      this.logger.log(
        `resend-confirmation: no email sent for ${email} (${user ? user.status : 'no account'})`,
      );
    }
  }

  async login(
    input: { identifier: string; password: string },
    req: Request,
    res: Response,
  ): Promise<UserProfile> {
    const user = await this.users.findByIdentifier(input.identifier);
    // verifyPassword runs scrypt even when the user is missing or DELETED (empty hash),
    // so the response time does not reveal whether the identifier exists.
    const ok = await this.users.verifyPassword(user, input.password);
    if (!user || !ok || user.status === 'DELETED') throw authError.invalidCredentials();
    if (user.status === 'DISABLED') throw authError.accountDisabled();
    await this.users.markLogin(user);
    await this.openSession(user, req, res);
    return this.users.toProfile(user);
  }

  async logout(session: Session | undefined, res: Response): Promise<void> {
    if (session) await this.sessions.revoke(session.id);
    clearSessionCookie(res, { secure: this.secureCookie });
  }

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.status !== 'ENABLED') {
      this.logger.log(
        `forgot-password: no email sent for ${email} (${user ? user.status : 'no account'})`,
      );
      return;
    }
    const token = await this.tokens.issue(user, 'RESET_PASSWORD');
    const content = resetPassword({
      username: user.username,
      link: `${this.publicBaseUrl}/reset-password/${token}`,
      ttlMinutes: this.tokens.resetTtlMinutes,
    });
    await this.mail.send({ to: user.email, ...content });
  }

  /** New password, every session revoked (the user signs in again). */
  async resetPassword(token: string, password: string): Promise<void> {
    const user = await this.tokens.consume(token, 'RESET_PASSWORD');
    if (!user || user.status !== 'ENABLED') throw authError.tokenInvalid();
    await this.users.setPassword(user, password);
    await this.sessions.revokeAll(user.id);
  }

  /** Keeps the current session, revokes the others. */
  async changePassword(
    user: User,
    session: Session,
    input: { current_password: string; new_password: string },
  ): Promise<void> {
    if (!(await this.users.verifyPassword(user, input.current_password))) {
      throw authError.wrongPassword();
    }
    await this.users.setPassword(user, input.new_password);
    await this.sessions.revokeAll(user.id, session.id);
  }

  async deleteAccount(user: User, password: string, res: Response): Promise<void> {
    if (!(await this.users.verifyPassword(user, password))) throw authError.wrongPassword();
    await this.users.anonymizeAndDelete(user);
    clearSessionCookie(res, { secure: this.secureCookie });
    this.logger.log(`account ${user.id} deleted by its owner`);
  }

  private async sendConfirmation(user: User): Promise<void> {
    const token = await this.tokens.issue(user, 'CONFIRM_EMAIL');
    const content = confirmEmail({
      username: user.username,
      link: `${this.publicBaseUrl}/confirm/${token}`,
      ttlHours: this.tokens.confirmTtlHours,
    });
    const sent = await this.mail.send({ to: user.email, ...content });
    if (!sent) this.logger.warn(`confirmation email not sent for user ${user.id}`);
  }

  private async openSession(user: User, req: Request, res: Response): Promise<void> {
    const { token } = await this.sessions.create(user, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setSessionCookie(res, token, {
      maxAgeSeconds: this.sessions.ttlSeconds,
      secure: this.secureCookie,
    });
  }
}
