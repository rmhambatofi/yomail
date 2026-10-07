import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pair, ReplayResult } from '@yomail/shared';
import { authError } from '../auth/auth-error';
import type { Env } from '../config/env';
import { isLocalHostname, isPublicAddress } from './address-guard';
import type { DetailRow } from './request.mapper';

/** Response bytes kept; the rest is discarded and `truncated` is set. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 2048;
const USER_AGENT = 'yomail-replay/1 (+https://yo.manitra.fr)';

/**
 * Request headers that must not be forwarded: framing/connection headers, the ones
 * Apache/Passenger added in front of the capture, and `Host` (recomputed by Node).
 */
const DROPPED_REQUEST_HEADER =
  /^(host|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|expect|proxy-.*|x-forwarded-.*|x-real-ip|via|passenger-.*|x-sendfile|forwarded)$/i;

/**
 * Re-sends a stored request to a URL chosen by the endpoint owner (phase 8.3).
 * SSRF defence: http(s) only, no credentials in the URL, and every address the
 * target resolves to is checked at connection time through a custom `lookup`, so
 * there is no window between the check and the connection. Redirects are returned
 * as they are (never followed), one attempt, bounded time and response size.
 */
@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);
  private readonly timeoutMs: number;
  private readonly allowPrivate: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.timeoutMs = config.get('REPLAY_TIMEOUT_MS', { infer: true });
    this.allowPrivate = config.get('REPLAY_ALLOW_PRIVATE', { infer: true }) === 1;
  }

  /** Throws 400 VALIDATION (`target_url`) when the URL is not an acceptable public http(s) target. */
  validateTarget(raw: string): URL {
    const reject = (message: string) => authError.validation({ target_url: message });
    if (raw.length > MAX_URL_LENGTH) throw reject(`at most ${MAX_URL_LENGTH} characters`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw reject('invalid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw reject('http or https only');
    if (url.username || url.password) throw reject('credentials in the URL are not allowed');
    if (!url.hostname) throw reject('missing host');
    if (url.port) {
      const port = Number(url.port);
      if (port !== 80 && port !== 443 && port < 1024) throw reject('port not allowed');
    }
    if (!this.allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isLocalHostname(host)) throw reject('local targets are not allowed');
      if (/^[\d.]+$|:/.test(host) && !isPublicAddress(host)) {
        throw reject('private or reserved addresses are not allowed');
      }
    }
    return url;
  }

  async replay(row: DetailRow, target: URL): Promise<ReplayResult> {
    const headers = forwardedHeaders(row.headers);
    const body = row.body !== null ? Buffer.from(row.body, 'utf8') : null;
    let warning: string | undefined;
    if (row.contentKind === 'multipart' || row.contentKind === 'binary') {
      warning = `${row.contentKind} bodies are not stored: the request was sent without a body`;
    }
    if (body) headers.push(['content-length', String(body.length)]);

    const started = Date.now();
    const result = await new Promise<Omit<ReplayResult, 'duration_ms' | 'warning'>>(
      (resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.request(
          target,
          {
            method: row.method,
            headers: Object.fromEntries(headers),
            lookup: this.guardedLookup(),
            timeout: this.timeoutMs,
            // A fresh socket per replay: no keep-alive pool to poison.
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            let truncated = false;
            res.on('data', (chunk: Buffer) => {
              if (truncated) return;
              if (size + chunk.length > MAX_RESPONSE_BYTES) {
                chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
                size = MAX_RESPONSE_BYTES;
                truncated = true;
                res.destroy();
                finish();
                return;
              }
              chunks.push(chunk);
              size += chunk.length;
            });
            res.on('end', finish);
            res.on('error', (err) => reject(err));
            let done = false;
            function finish(): void {
              if (done) return;
              done = true;
              const buffer = Buffer.concat(chunks);
              resolve({
                status: res.statusCode ?? 0,
                headers: pairsFromRaw(res.rawHeaders),
                body: buffer.length === 0 ? null : buffer.toString('utf8'),
                truncated,
              });
            }
          },
        );
        const overall = setTimeout(() => {
          req.destroy(new Error(`no response within ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        overall.unref();
        req.on('timeout', () => req.destroy(new Error(`no response within ${this.timeoutMs} ms`)));
        req.on('error', (err) => {
          clearTimeout(overall);
          reject(err);
        });
        req.on('close', () => clearTimeout(overall));
        if (body) req.end(body);
        else req.end();
      },
    ).catch((err: Error) => {
      this.logger.warn(`replay of ${row.id} to ${target.host} failed: ${err.message}`);
      throw authError.replayFailed(err.message);
    });

    const duration_ms = Date.now() - started;
    if (result.body !== null && result.body.includes('\u0000')) {
      result.body = null;
      warning = warning ? `${warning}; binary response body omitted` : 'binary response body omitted';
    }
    return warning ? { ...result, duration_ms, warning } : { ...result, duration_ms };
  }

  /** `dns.lookup` that refuses every non-public address, at the moment the socket connects. */
  private guardedLookup(): LookupFunction {
    const allowPrivate = this.allowPrivate;
    return (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) {
          callback(err, '', 0);
          return;
        }
        const list = Array.isArray(addresses) ? addresses : [];
        const allowed = allowPrivate ? list : list.filter((a) => isPublicAddress(a.address));
        if (allowed.length === 0) {
          callback(new Error(`${hostname} resolves to a private or reserved address`), '', 0);
          return;
        }
        if (options.all) {
          // Node's happy-eyeballs path asks for every address.
          (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, allowed);
          return;
        }
        const first = allowed[0]!;
        callback(null, first.address, first.family);
      });
    };
  }
}

/** Forwardable request headers plus a User-Agent when the original had none. */
function forwardedHeaders(headers: Pair[]): Pair[] {
  const kept: Pair[] = headers.filter(([name]) => !DROPPED_REQUEST_HEADER.test(name));
  if (!kept.some(([name]) => name.toLowerCase() === 'user-agent')) {
    kept.push(['user-agent', USER_AGENT]);
  }
  return kept;
}

function pairsFromRaw(raw: string[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
  return pairs;
}
