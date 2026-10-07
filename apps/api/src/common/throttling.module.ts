import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Env } from '../config/env';

/**
 * One in-process throttler for the whole API, so `ThrottlerGuard` can be used by any
 * controller (auth routes, replay). The default limit is the auth one; routes that
 * need another budget override it with `@Throttle(...)`. Memory only: with several
 * Passenger processes the effective limit is multiplied by their number (accepted).
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            ttl: config.get('AUTH_RATE_WINDOW_MINUTES', { infer: true }) * 60_000,
            limit: config.get('AUTH_RATE_LIMIT', { infer: true }),
          },
        ],
      }),
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}
