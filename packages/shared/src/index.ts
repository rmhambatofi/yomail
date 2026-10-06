/**
 * Shared contracts between apps/api and apps/web.
 * This file is the single source of truth for the endpoint id rule.
 */

/** Endpoint ids are UUID v4, compared case-insensitively and stored lowercase. */
export const ENDPOINT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Loose UUID shape, used to find an id inside a pasted URL before validating it. */
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Extracts an endpoint id from a raw UUID or a full endpoint URL
 * (`https://yo.manitra.fr/<uuid>/sub/path?x=1`). Returns the lowercase id,
 * or `null` when no valid UUID v4 is found.
 */
export function extractEndpointId(input: string): string | null {
  const match = UUID_IN_TEXT.exec(input.trim());
  if (!match) return null;
  const candidate = match[0].toLowerCase();
  return ENDPOINT_ID_REGEX.test(candidate) ? candidate : null;
}

/** First 8 hex chars of an endpoint id, display only. */
export function shortEndpointId(id: string): string {
  return id.slice(0, 8);
}

/** `#` + first 5 hex chars of a request id, display only. */
export function shortRequestId(id: string): string {
  return `#${id.slice(0, 5)}`;
}

/** How the capture classified the request body from its Content-Type. */
export type ContentKind =
  'none' | 'json' | 'form' | 'multipart' | 'html' | 'xml' | 'text' | 'binary';

export const CONTENT_KINDS: readonly ContentKind[] = [
  'none',
  'json',
  'form',
  'multipart',
  'html',
  'xml',
  'text',
  'binary',
];

/** Name/value pair; arrays keep duplicates and the order received. */
export type Pair = [name: string, value: string];

export interface DroppedFile {
  field: string;
  filename: string;
  size: number;
}

export interface EndpointSummary {
  id: string;
  /** Public capture URL: PUBLIC_BASE_URL + '/' + id */
  url: string;
  /** ISO 8601 */
  created_at: string;
}

export interface EndpointDetail extends EndpointSummary {
  /** ISO 8601, null until the first request */
  last_request_at: string | null;
  request_count: number;
  retention_days: number;
}

/** One row in an inbox listing. */
export interface RequestSummary {
  id: string;
  endpoint_id: string;
  method: string;
  /** Sub-path after the endpoint id, '/' when none */
  path: string;
  client_ip: string | null;
  content_kind: ContentKind;
  size_bytes: number;
  /** ISO 8601 */
  received_at: string;
  /** ISO 8601, computed as received_at + retention_days; never persisted */
  expires_at: string;
}

/** Full request as returned by GET /endpoints/:id/requests/:rid */
export interface RequestDetail extends RequestSummary {
  query_params: Pair[] | null;
  headers: Pair[];
  content_type: string | null;
  /** Raw body text; null for none, multipart and binary */
  body: string | null;
  form_fields: Pair[] | null;
  dropped_files: DroppedFile[] | null;
  /** Server-sanitized HTML, computed on read when content_kind is html; render only inside a sandboxed iframe */
  html_sanitized: string | null;
}

export interface RequestListResponse {
  endpoint_id: string;
  retention_days: number;
  requests: RequestSummary[];
  /** true when the page was full and older rows may exist (use ?before=) */
  has_more: boolean;
}

/** Body returned to the caller of a capture URL. */
export interface CaptureResponse {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  retention_days: number;
  max_body_bytes: number;
}

export interface ApiError {
  statusCode: number;
  message: string;
  error?: string;
}

/** Socket.IO events, client -> server. */
export interface ClientToServerEvents {
  subscribe: (payload: { endpointId: string }) => void;
  unsubscribe: (payload: { endpointId: string }) => void;
}

/** Socket.IO events, server -> client. */
export interface ServerToClientEvents {
  'request:new': (request: RequestSummary) => void;
  'request:deleted': (payload: { endpointId: string; id: string }) => void;
  'endpoint:cleared': (payload: { endpointId: string }) => void;
  'endpoint:deleted': (payload: { endpointId: string }) => void;
}
