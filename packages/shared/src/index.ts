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

/**
 * Endpoint metadata. An endpoint owned by a member is private: this detail, its inbox and
 * its live events are served to the owner only (401 without a session, 403 NOT_OWNER for
 * another member); an ownerless endpoint is readable by whoever knows the UUID.
 */
export interface EndpointDetail extends EndpointSummary {
  /** ISO 8601, null until the first request */
  last_request_at: string | null;
  request_count: number;
  /** Retention that applies to this endpoint (members' value when it has an owner). */
  retention_days: number;
  /** Cap on stored requests for this endpoint (members' value when it has an owner). */
  max_requests: number;
  /** Display name set by the owner (phase 8), null otherwise. */
  name: string | null;
  /** True when a member owns this endpoint (then the caller is that owner, or would not see this). */
  has_owner: boolean;
  /** True when the caller's session is the owner. */
  owned: boolean;
  /** True when the owner configured the response (phase 8). */
  custom_response: boolean;
  /** The configured response itself; null when default. */
  response: ResponseConfig | null;
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
  /** Free text set by the endpoint owner (phase 8), null otherwise. */
  note: string | null;
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
  /** Retention of anonymous endpoints */
  retention_days: number;
  /** Retention of endpoints owned by a member */
  retention_days_members: number;
  max_body_bytes: number;
  max_requests_per_endpoint: number;
  max_requests_per_endpoint_members: number;
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
  /** A member took the endpoint: it is private from now on; readers must re-check their access. */
  'endpoint:claimed': (payload: { endpointId: string }) => void;
}

// ---------------------------------------------------------------------------
// User accounts (phase 7). Single source of truth for the validation rules
// applied by the API (zod), the web forms and the admin CLI.
// ---------------------------------------------------------------------------

export type UserRole = 'ADMIN' | 'STANDARD';
export const USER_ROLES: readonly UserRole[] = ['ADMIN', 'STANDARD'];

/**
 * DISABLED: created, email not confirmed yet (login refused).
 * ENABLED: active. DELETED: removed by its owner, row kept anonymized.
 */
export type UserStatus = 'DISABLED' | 'ENABLED' | 'DELETED';
export const USER_STATUSES: readonly UserStatus[] = ['DISABLED', 'ENABLED', 'DELETED'];

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
/** Letters, digits and underscore; uniqueness is case-insensitive (DB collation). */
export const USERNAME_REGEX = /^[A-Za-z0-9_]+$/;
export const EMAIL_MAX_LENGTH = 254;
/** Loose shape check; the mailbox is proven by the confirmation email anyway. */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Emails are compared and stored lowercase. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** Public view of a user; never carries the password hash or any token. */
export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  /** ISO 8601 */
  created_at: string;
}

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'EMAIL_TAKEN'
  | 'USERNAME_TAKEN'
  | 'TOKEN_INVALID'
  | 'WRONG_PASSWORD'
  | 'UNAUTHENTICATED'
  | 'VALIDATION'
  /** 403: the endpoint belongs to another member (or is already owned, for claim) */
  | 'NOT_OWNER'
  /** 502: the replay target could not be reached or timed out */
  | 'REPLAY_FAILED';

/** Error body of the auth and account routes; clients branch on `code`, never on `message`. */
export interface AuthErrorBody {
  statusCode: number;
  code: AuthErrorCode;
  message: string;
  /** Field name -> first problem, for 400 VALIDATION */
  fields?: Record<string, string>;
}

export interface OkResponse {
  ok: true;
}

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  /** Email (contains @) or username */
  identifier: string;
  password: string;
}

export interface ConfirmRequest {
  token: string;
}

export interface EmailRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  password: string;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface DeleteAccountRequest {
  password: string;
}

// ---------------------------------------------------------------------------
// Member features (phase 8): named endpoints, configurable response, notes,
// replay. Validation bounds shared by the API (zod) and the web forms.
// ---------------------------------------------------------------------------

export const ENDPOINT_NAME_MAX_LENGTH = 80;
export const NOTE_MAX_LENGTH = 2000;

export const RESPONSE_BODY_MAX_LENGTH = 64 * 1024;
export const RESPONSE_MAX_HEADERS = 20;
export const RESPONSE_HEADER_NAME_MAX_LENGTH = 64;
export const RESPONSE_HEADER_VALUE_MAX_LENGTH = 1024;
export const RESPONSE_MAX_DELAY_MS = 10_000;
export const RESPONSE_CONTENT_TYPE_MAX_LENGTH = 255;
/** RFC 7230 token. */
export const HEADER_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Response headers an owner may not set: framing and connection headers, cookies
 * (the capture URL shares the SPA origin, a Set-Cookie could overwrite the
 * session), and the headers the server always controls (CORS, CSP, nosniff).
 * Compared lowercase.
 */
export const RESPONSE_FORBIDDEN_HEADERS: readonly string[] = [
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'trailer',
  'te',
  'host',
  'set-cookie',
  'set-cookie2',
  'content-type',
  'content-security-policy',
  'x-content-type-options',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
];

/** What a capture URL answers once configured by its owner; null = default `200 {"ok":true,"id"}`. */
export interface ResponseConfig {
  /** 100–599 */
  status: number;
  content_type: string;
  /** Up to RESPONSE_BODY_MAX_LENGTH characters, may be empty */
  body: string;
  /** Up to RESPONSE_MAX_HEADERS pairs, none from RESPONSE_FORBIDDEN_HEADERS */
  headers: Pair[];
  /** 0–RESPONSE_MAX_DELAY_MS, waited after the request is stored */
  delay_ms: number;
}

export const DEFAULT_RESPONSE_CONFIG: ResponseConfig = {
  status: 200,
  content_type: 'application/json',
  body: '{"ok":true}',
  headers: [],
  delay_ms: 0,
};

/** One row of "My endpoints" (GET /api/account/endpoints). */
export interface OwnedEndpointSummary extends EndpointSummary {
  name: string | null;
  last_request_at: string | null;
  request_count: number;
}

export interface AccountEndpointsResponse {
  endpoints: OwnedEndpointSummary[];
}

/** PATCH /api/endpoints/:id; absent fields are left unchanged, null clears. */
export interface UpdateEndpointRequest {
  name?: string | null;
  response?: ResponseConfig | null;
}

/** PATCH /api/endpoints/:id/requests/:rid */
export interface UpdateNoteRequest {
  note: string | null;
}

export interface ReplayRequest {
  target_url: string;
}

/** Outcome of a replay; the target's own status is reported, whatever it is. */
export interface ReplayResult {
  status: number;
  headers: Pair[];
  /** Response body as text, null when empty or not text; cut at 64 KB */
  body: string | null;
  truncated: boolean;
  duration_ms: number;
  /** Set when something could not be reproduced (body not stored, binary response omitted) */
  warning?: string;
}
