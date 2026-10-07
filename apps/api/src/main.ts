import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { CAPTURE_PREFIX_EXCLUDES, excludeLiteralRoutes, isCapturePath } from './capture/routes';
import type { Env } from './config/env';
import { ConfiguredIoAdapter, socketIoPath } from './live/socket-io.adapter';
import { DEV_MAIL_CATCHER_ROUTES } from './mail/dev-mail-catcher.controller';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // No global body parser: the capture route streams its own raw body (see capture/raw-body.ts)
    // so the endpoint existence check runs before any byte is buffered and the size limit is
    // enforced without destroying the socket. Routes needing JSON must opt in per route.
    bodyParser: false,
  });
  const config = app.get(ConfigService<Env, true>);
  const logger = new Logger('bootstrap');

  // Capture routes (/<uuid>, /<uuid>/sub/path) and the dev mail catcher (/devmailcatcher,
  // admin-only) stay at the site root, outside the prefix.
  const prefix = config.get('API_PREFIX', { infer: true });
  if (prefix) {
    app.setGlobalPrefix(prefix, {
      exclude: [...CAPTURE_PREFIX_EXCLUDES, ...excludeLiteralRoutes(DEV_MAIL_CATCHER_ROUTES)],
    });
  }

  // CORS for the API only. The capture controller sets its own open CORS headers and must
  // see OPTIONS requests itself: the cors middleware would otherwise end preflights with 204.
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true });
  const corsOrigins = corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : undefined;
  if (corsOrigins) {
    const apiCors = cors({ origin: corsOrigins });
    app.use((req: Request, res: Response, next: NextFunction) =>
      isCapturePath(req.path) ? next() : apiCors(req, res, next),
    );
  }

  // Session cookie for the auth guards. Capture paths never need it.
  const cookies = cookieParser();
  app.use((req: Request, res: Response, next: NextFunction) =>
    isCapturePath(req.path) ? next() : cookies(req, res, next),
  );

  // Socket.IO shares the HTTP server (Passenger forwards a single port) under /<prefix>/socket.io.
  app.useWebSocketAdapter(
    new ConfiguredIoAdapter(app, {
      path: socketIoPath(prefix),
      cors: corsOrigins ? { origin: corsOrigins } : undefined,
      maxHttpBufferSize: 16 * 1024,
    }),
  );

  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  // Behind Apache/Passenger the client address arrives in X-Forwarded-For.
  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  if (trustProxy > 0) express.set('trust proxy', trustProxy);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Passenger injects PORT; locally we fall back to the validated default.
  const port = Number(process.env.PORT ?? config.get('PORT', { infer: true }));
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/${prefix}`);
}

void bootstrap();
