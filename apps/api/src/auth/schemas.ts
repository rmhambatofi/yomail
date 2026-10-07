import { z } from 'zod';
import {
  EMAIL_MAX_LENGTH,
  EMAIL_REGEX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
  normalizeEmail,
} from '@yomail/shared';

/** Request body schemas; the rules themselves live in @yomail/shared. */

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH, `at least ${USERNAME_MIN_LENGTH} characters`)
  .max(USERNAME_MAX_LENGTH, `at most ${USERNAME_MAX_LENGTH} characters`)
  .regex(USERNAME_REGEX, 'letters, digits and underscore only');

export const emailSchema = z
  .string()
  .trim()
  .max(EMAIL_MAX_LENGTH, `at most ${EMAIL_MAX_LENGTH} characters`)
  .regex(EMAIL_REGEX, 'invalid email address')
  .transform(normalizeEmail);

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `at most ${PASSWORD_MAX_LENGTH} characters`);

/** 32 random bytes in base64url. */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'malformed token');

export const signupSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'required').max(EMAIL_MAX_LENGTH),
  password: z.string().min(1, 'required').max(PASSWORD_MAX_LENGTH),
});

export const confirmSchema = z.object({ token: tokenSchema });

export const emailOnlySchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });

export const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'required').max(PASSWORD_MAX_LENGTH),
  new_password: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'required').max(PASSWORD_MAX_LENGTH),
});

export type SignupBody = z.infer<typeof signupSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type ConfirmBody = z.infer<typeof confirmSchema>;
export type EmailOnlyBody = z.infer<typeof emailOnlySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
export type DeleteAccountBody = z.infer<typeof deleteAccountSchema>;
