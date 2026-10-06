import type { RequestDetail, RequestSummary } from '@yomail/shared';
import { sanitizeHtmlBody } from './html-sanitizer';
import type { CapturedRequest } from './request.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Property names (camelCase) loaded for a listing; never body, headers or form fields. */
export const SUMMARY_COLUMNS = [
  'id',
  'endpointId',
  'method',
  'path',
  'clientIp',
  'contentKind',
  'sizeBytes',
  'receivedAt',
] as const satisfies readonly (keyof CapturedRequest)[];

export const DETAIL_COLUMNS = [
  ...SUMMARY_COLUMNS,
  'queryParams',
  'headers',
  'contentType',
  'body',
  'formFields',
  'droppedFiles',
] as const satisfies readonly (keyof CapturedRequest)[];

export type SummaryRow = Pick<CapturedRequest, (typeof SUMMARY_COLUMNS)[number]>;
export type DetailRow = Pick<CapturedRequest, (typeof DETAIL_COLUMNS)[number]>;

/** expires_at is derived at read time so a retention change applies to every row at once. */
export function expiresAt(receivedAt: Date, retentionDays: number): string {
  return new Date(receivedAt.getTime() + retentionDays * DAY_MS).toISOString();
}

export function toSummary(row: SummaryRow, retentionDays: number): RequestSummary {
  return {
    id: row.id,
    endpoint_id: row.endpointId,
    method: row.method,
    path: row.path,
    client_ip: row.clientIp,
    content_kind: row.contentKind,
    size_bytes: row.sizeBytes,
    received_at: row.receivedAt.toISOString(),
    expires_at: expiresAt(row.receivedAt, retentionDays),
  };
}

export function toDetail(row: DetailRow, retentionDays: number): RequestDetail {
  return {
    ...toSummary(row, retentionDays),
    query_params: row.queryParams,
    headers: row.headers,
    content_type: row.contentType,
    body: row.body,
    form_fields: row.formFields,
    dropped_files: row.droppedFiles,
    // Sanitized on every read, never stored: the whitelist can evolve without a migration.
    html_sanitized: row.contentKind === 'html' && row.body ? sanitizeHtmlBody(row.body) : null,
  };
}
