import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import type { ServeStaticModuleOptions } from '@nestjs/serve-static';
import type { Env } from '../config/env';

/** apps/api, whether running from src/ (ts-node) or dist/ (compiled). */
const APP_ROOT = resolve(__dirname, '../..');
const ONE_YEAR = 365 * 24 * 60 * 60;

/**
 * Serves the built SPA (apps/web/dist) from the same process as the API, so a single
 * Passenger app mounted at the subdomain root handles everything. Nothing is served
 * when WEB_DIST_DIR is empty (development: Vite serves the SPA and proxies to the API).
 *
 * Routing order is what makes this safe: Nest registers the controllers (/api/*, /<uuid>)
 * first, then ServeStaticModule adds express.static and the GET * fallback to index.html,
 * from which the API prefix is excluded so unknown /api paths get a JSON 404.
 */
@Module({
  imports: [
    ServeStaticModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ServeStaticModuleOptions[] => {
        const dir = config.get('WEB_DIST_DIR', { infer: true });
        if (!dir) return [];
        const prefix = config.get('API_PREFIX', { infer: true }).replace(/^\/+|\/+$/g, '');
        return [
          {
            rootPath: resolve(APP_ROOT, dir),
            exclude: prefix ? [`/${prefix}`, `/${prefix}/(.*)`] : [],
            serveStaticOptions: {
              // Vite emits content-hashed files under assets/: cache them forever.
              // index.html (direct or via the SPA fallback) must always be revalidated.
              setHeaders: (res, path) => {
                const immutable = /[\\/]assets[\\/]/.test(path);
                res.setHeader(
                  'Cache-Control',
                  immutable ? `public, max-age=${ONE_YEAR}, immutable` : 'no-cache',
                );
              },
            },
          },
        ];
      },
    }),
  ],
})
export class StaticModule {}
