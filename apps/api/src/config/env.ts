import { z } from 'zod';

/**
 * Validated process environment. Loaded once by ConfigModule (see app.module.ts).
 * DB_USER and DB_NAME are required; everything else has a default.
 */
export const envSchema = z.object({
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
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
