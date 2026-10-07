/** Headers added by Apache/Passenger in production: dimmed in the UI, left out of exports. */
const PROXY_HEADER = /^(x-forwarded-|x-real-ip$|x-sendfile|passenger-|via$|forwarded$)/i;

export function isProxyHeader(name: string): boolean {
  return PROXY_HEADER.test(name);
}

/** Headers curl sets itself or that describe the original connection, not the request. */
const TRANSPORT_HEADER = /^(host|content-length|connection|keep-alive|transfer-encoding|expect)$/i;

export function isTransportHeader(name: string): boolean {
  return TRANSPORT_HEADER.test(name);
}
