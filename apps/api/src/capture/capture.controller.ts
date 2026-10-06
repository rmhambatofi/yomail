import { All, Controller, Logger, Param, PayloadTooLargeException, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ENDPOINT_ID_REGEX } from '@yomail/shared';
import type { CaptureResponse, Pair } from '@yomail/shared';
import type { Env } from '../config/env';
import { EndpointsService } from '../endpoints/endpoints.service';
import { CaptureService } from './capture.service';
import { parseContent } from './content';
import { readRawBody } from './raw-body';
import { CAPTURE_PARAM, CAPTURE_ROUTE_ROOT, CAPTURE_ROUTE_SUBPATH } from './routes';

const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Catches every HTTP request sent to `/<uuid>[/sub/path]`. Responses are written
 * by hand (no Nest exception filter) so every outcome, including 404 and 413,
 * carries the open CORS headers and the `{ ok, id | error }` body.
 * Order matters: validate the id, check the endpoint exists, only then read the body.
 */
@Controller()
export class CaptureController {
  private readonly logger = new Logger(CaptureController.name);
  private readonly maxBodyBytes: number;

  constructor(
    private readonly endpoints: EndpointsService,
    private readonly capture: CaptureService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBodyBytes = config.get('MAX_BODY_BYTES', { infer: true });
  }

  @All(CAPTURE_ROUTE_ROOT)
  root(@Param(CAPTURE_PARAM) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.handle(id, req, res);
  }

  @All(CAPTURE_ROUTE_SUBPATH)
  subPath(
    @Param(CAPTURE_PARAM) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.handle(id, req, res);
  }

  private async handle(rawId: string, req: Request, res: Response): Promise<void> {
    setCorsHeaders(req, res);

    const endpointId = rawId.toLowerCase();
    if (!ENDPOINT_ID_REGEX.test(endpointId) || !(await this.endpoints.exists(endpointId))) {
      reply(res, 404, { ok: false, error: 'unknown endpoint' });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req, this.maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeException) {
        reply(res, 413, { ok: false, error: `body too large (max ${this.maxBodyBytes} bytes)` });
      } else {
        reply(res, 400, { ok: false, error: (err as Error).message });
      }
      return;
    }

    const contentType = req.headers['content-type']?.slice(0, 255) ?? null;
    try {
      const row = await this.capture.store({
        endpointId,
        method: req.method.toUpperCase(),
        // req.path has no query string; the endpoint id occupies the first 37 chars ("/" + uuid).
        path: req.path.slice(37) || '/',
        queryParams: parseQuery(req.url),
        headers: pairsFromRawHeaders(req.rawHeaders),
        clientIp: normalizeIp(req.ip),
        contentType,
        sizeBytes: raw.length,
        content: await parseContent(contentType, raw),
      });
      reply(res, 200, { ok: true, id: row.id });
    } catch (err) {
      this.logger.error(`capture failed for ${endpointId}: ${(err as Error).stack ?? err}`);
      reply(res, 500, { ok: false, error: 'internal error' });
    }
  }
}

function setCorsHeaders(req: Request, res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ?? '*',
  );
  res.setHeader('Access-Control-Max-Age', '600');
}

function reply(res: Response, status: number, body: CaptureResponse): void {
  res.status(status);
  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** [name, value] pairs in the order sent; nothing is lowercased or merged. */
function pairsFromRawHeaders(rawHeaders: string[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    pairs.push([rawHeaders[i]!, rawHeaders[i + 1]!]);
  return pairs;
}

function parseQuery(url: string): Pair[] | null {
  const q = url.indexOf('?');
  if (q === -1 || q === url.length - 1) return null;
  const pairs: Pair[] = [];
  for (const [name, value] of new URLSearchParams(url.slice(q + 1))) pairs.push([name, value]);
  return pairs.length > 0 ? pairs : null;
}

/** Strips the IPv4-mapped prefix Node adds on dual-stack sockets (::ffff:1.2.3.4). */
function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
