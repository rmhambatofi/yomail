import { HttpException } from '@nestjs/common';
import type { AuthErrorBody, AuthErrorCode } from '@yomail/shared';

/**
 * Error shape of the auth and account routes: `{ statusCode, code, message, fields? }`.
 * Clients branch on `code`; `message` is for humans and may change.
 */
export class AuthHttpException extends HttpException {
  readonly code: AuthErrorCode;

  constructor(
    status: number,
    code: AuthErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    const body: AuthErrorBody = { statusCode: status, code, message };
    if (fields) body.fields = fields;
    super(body, status);
    this.code = code;
  }
}

export const authError = {
  unauthenticated: () => new AuthHttpException(401, 'UNAUTHENTICATED', 'Sign in required'),
  invalidCredentials: () =>
    new AuthHttpException(401, 'INVALID_CREDENTIALS', 'Wrong email/username or password'),
  accountDisabled: () =>
    new AuthHttpException(403, 'ACCOUNT_DISABLED', 'Confirm your email address first'),
  emailTaken: () => new AuthHttpException(409, 'EMAIL_TAKEN', 'This email is already registered'),
  usernameTaken: () =>
    new AuthHttpException(409, 'USERNAME_TAKEN', 'This username is already taken'),
  tokenInvalid: () =>
    new AuthHttpException(400, 'TOKEN_INVALID', 'This link is invalid or has expired'),
  wrongPassword: () => new AuthHttpException(400, 'WRONG_PASSWORD', 'Wrong current password'),
  validation: (fields: Record<string, string>) =>
    new AuthHttpException(400, 'VALIDATION', 'Invalid request', fields),
  notOwner: () =>
    new AuthHttpException(403, 'NOT_OWNER', 'Only the owner of this endpoint can do that'),
  replayFailed: (message: string) => new AuthHttpException(502, 'REPLAY_FAILED', message),
};
