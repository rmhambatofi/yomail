import type { RequestDetail } from '@yomail/shared';
import { isProxyHeader, isTransportHeader } from './headers';

/** Single-quoted POSIX shell word; an embedded quote becomes '\'' . */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Full URL of a captured request: endpoint URL + sub-path + query string. */
export function requestUrl(request: RequestDetail, endpointUrl: string): string {
  const query = request.query_params?.length
    ? '?' + new URLSearchParams(request.query_params).toString()
    : '';
  return `${endpointUrl}${request.path === '/' ? '' : request.path}${query}`;
}

/**
 * A curl command that re-sends the captured request (phase 8.3). Transport headers
 * and the proxy's own headers are left out; the body is passed verbatim with
 * --data-binary. Bodies that were not stored (multipart files, binary) are noted.
 */
export function toCurl(request: RequestDetail, endpointUrl: string): string {
  const lines = [`curl -X ${request.method} ${shellQuote(requestUrl(request, endpointUrl))}`];
  for (const [name, value] of request.headers) {
    if (isTransportHeader(name) || isProxyHeader(name)) continue;
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (request.body !== null && request.body.length > 0) {
    lines.push(`  --data-binary ${shellQuote(request.body)}`);
  } else if (request.content_kind === 'multipart' || request.content_kind === 'binary') {
    lines.push(`  # ${request.content_kind} body not stored (${request.size_bytes} bytes)`);
  }
  return lines.join(' \\\n');
}
