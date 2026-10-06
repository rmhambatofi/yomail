import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Reads the whole request body into a Buffer, rejecting with 413 as soon as
 * `maxBytes` is exceeded. The socket is deliberately NOT destroyed: doing so
 * would cut the connection before the 413 is written (curl then only sees the
 * "100 Continue"). Remaining bytes are received and dropped by the no-op listener.
 * Used instead of body-parser so the endpoint existence check runs before any
 * byte is read. An absent body resolves to an empty Buffer.
 */
export function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new PayloadTooLargeException(`Body exceeds ${maxBytes} bytes`));
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new PayloadTooLargeException(`Body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => fail(new BadRequestException(`Body read error: ${err.message}`)));
    req.on('aborted', () => fail(new BadRequestException('Request aborted')));
  });
}
