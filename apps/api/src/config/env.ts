import { z } from 'zod';

/**
 * Validated process environment. Loaded once by ConfigModule (see app.module.ts).
 * DB_USER and DB_NAME are required; everything else has a default.
 */
const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api'),
  /** Base of the capture URLs returned by the API, no trailing slash. */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:5173')
    .transform((s) => s.replace(/\/+$/, '')),
  /** Directory of the built SPA served by Nest; empty = do not serve (Vite dev server). */
  WEB_DIST_DIR: z.string().default(''),
  /** 1 behind Apache/Passenger so req.ip reflects X-Forwarded-For. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  CORS_ORIGIN: z.string().optional(),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),

  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024),
  MAX_REQUESTS_PER_ENDPOINT: z.coerce.number().int().positive().default(500),
  RETENTION_DAYS_DEFAULT: z.coerce.number().int().positive().default(10),

  // ---- Member features (phase 8): limits of endpoints owned by a member ----
  MAX_REQUESTS_PER_ENDPOINT_MEMBERS: z.coerce.number().int().positive().default(2000),
  /** Used when settings.retention_days_members is missing or invalid. */
  RETENTION_DAYS_MEMBERS_DEFAULT: z.coerce.number().int().positive().default(30),
  REPLAY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** 1 lets replay target loopback/private addresses; refused in production (tests only). */
  REPLAY_ALLOW_PRIVATE: z.coerce.number().int().min(0).max(1).default(0),

  /** Accounts never confirmed (status DISABLED, enabled_at NULL) are purged after this many days. */
  UNCONFIRMED_USER_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // ---- User accounts (phase 7) ----
  /** Login session lifetime (cookie and sessions table), no sliding renewal. */
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CONFIRM_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(48),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** Requests per IP and per window on the sensitive auth routes (per process). */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  /** SMTP is used in production only; outside it, emails are caught at /devmailcatcher. */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  /** 1 = implicit TLS (465); 0 = plain or STARTTLS. */
  SMTP_SECURE: z.coerce.number().int().min(0).max(1).default(1),
  /** Empty = no SMTP authentication. */
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('yomail <no-reply@localhost>'),
});

export const envSchema = envObject.superRefine((env, ctx) => {
  if (isProduction(env.NODE_ENV) && !env.SMTP_HOST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMTP_HOST'],
      message: 'required when NODE_ENV=production (account emails go through SMTP there)',
    });
  }
  if (isProduction(env.NODE_ENV) && env.REPLAY_ALLOW_PRIVATE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REPLAY_ALLOW_PRIVATE'],
      message: 'must stay 0 in production (SSRF guard)',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * The one place that decides what "production" means. Everything environment-
 * dependent (SMTP vs dev mail catcher, Secure cookies) goes through it.
 */
export function isProduction(nodeEnv: Env['NODE_ENV']): boolean {
  return nodeEnv === 'production';
}

/** Every validated key, for modules that rebuild the typed object from ConfigService. */
export const envKeys = Object.keys(envObject.shape) as Array<keyof Env>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
