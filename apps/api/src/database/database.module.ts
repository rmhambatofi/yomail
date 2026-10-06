import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Env } from '../config/env';
import { envSchema } from '../config/env';
import { buildDataSourceOptions } from './data-source';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        // ConfigModule already validated the env; rebuild the typed object from it.
        const env = envSchema.parse(
          Object.fromEntries(
            Object.keys(envSchema.shape).map((k) => [k, config.get(k as keyof Env)]),
          ),
        );
        return buildDataSourceOptions(env);
      },
    }),
  ],
})
export class DatabaseModule {}
