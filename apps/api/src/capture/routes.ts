import { RequestMethod } from '@nestjs/common';
import type { RouteInfo } from '@nestjs/common/interfaces';

/**
 * Capture routes live at the site root (`/<uuid>` and `/<uuid>/sub/path`), outside
 * the `/api` prefix. The Express 4 route pattern constrains the param to the UUID
 * shape so `/api/...` and SPA paths never reach the capture controller; the exact
 * v4 check happens in the controller (404 otherwise).
 */
const UUID_SHAPE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const CAPTURE_PARAM = 'endpointId';
export const CAPTURE_ROUTE_ROOT = `:${CAPTURE_PARAM}(${UUID_SHAPE})`;
export const CAPTURE_ROUTE_SUBPATH = `:${CAPTURE_PARAM}(${UUID_SHAPE})/*`;

/**
 * Patterns for `setGlobalPrefix(prefix, { exclude })`. Nest compiles each one with
 * path-to-regexp 3 and tests it against the *literal* route strings above (not against
 * incoming URLs). A loose pattern such as `:param` would also match `/health` and strip
 * the prefix from every single-segment API route, so the route strings are escaped
 * (`\:`, `\(`, `\)`, `\*`) to produce exact literal matches only.
 */
export const CAPTURE_PREFIX_EXCLUDES: RouteInfo[] = [CAPTURE_ROUTE_ROOT, CAPTURE_ROUTE_SUBPATH].map(
  (route) => ({ path: route.replace(/[:()*]/g, '\\$&'), method: RequestMethod.ALL }),
);

const CAPTURE_PATH = new RegExp(`^/${UUID_SHAPE}(/|$)`);

/** True for incoming request paths handled by the capture controller. */
export function isCapturePath(path: string): boolean {
  return CAPTURE_PATH.test(path);
}
