import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { Endpoint } from '../endpoints/endpoint.entity';
import { CaughtMail } from '../mail/caught-mail.entity';
import { CapturedRequest } from '../requests/request.entity';
import { Setting } from '../settings/setting.entity';
import { Session } from '../users/session.entity';
import { UserToken } from '../users/user-token.entity';
import { User } from '../users/user.entity';
import { migrations } from './migrations';
import { validateEnv } from '../config/env';
import type { Env } from '../config/env';

export const entities = [Endpoint, CapturedRequest, Setting, User, Session, UserToken, CaughtMail];

/** Shared by the Nest TypeOrmModule and the TypeORM CLI so both see one config. */
export function buildDataSourceOptions(env: Env): DataSourceOptions {
  return {
    type: 'mysql',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    entities,
    migrations,
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    logging: env.NODE_ENV === 'development' ? ['error', 'warn', 'migration'] : ['error'],
  };
}

/**
 * CLI entry point (typeorm -d). Loads .env from the repo root, then from the
 * app folder (cPanel layout), mirroring ConfigModule in app.module.ts.
 */
function loadEnvForCli(): Env {
  loadDotenv({ path: resolve(__dirname, '../../../../.env') });
  loadDotenv({ path: resolve(__dirname, '../../.env') });
  loadDotenv({ path: resolve(process.cwd(), '.env') });
  return validateEnv(process.env);
}

export default new DataSource(buildDataSourceOptions(loadEnvForCli()));
