import type {
  EndpointDetail,
  EndpointSummary,
  HealthStatus,
  RequestDetail,
  RequestListResponse,
} from '@yomail/shared';
import { API_URL } from '../config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The only place that calls fetch. Throws ApiError with the HTTP status so pages can special-case 400/404. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (body.message)
      message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message);
}

const enc = encodeURIComponent;

export interface ListParams {
  limit?: number;
  /** ISO date: only requests received strictly before it */
  before?: string;
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthStatus>('/health', { signal }),

  createEndpoint: () => request<EndpointSummary>('/endpoints', { method: 'POST' }),

  endpoint: (id: string, signal?: AbortSignal) =>
    request<EndpointDetail>(`/endpoints/${enc(id)}`, { signal }),

  deleteEndpoint: (id: string) => request<void>(`/endpoints/${enc(id)}`, { method: 'DELETE' }),

  requests: (id: string, params: ListParams = {}, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.before) qs.set('before', params.before);
    const suffix = qs.size > 0 ? `?${qs}` : '';
    return request<RequestListResponse>(`/endpoints/${enc(id)}/requests${suffix}`, { signal });
  },

  request: (id: string, rid: string, signal?: AbortSignal) =>
    request<RequestDetail>(`/endpoints/${enc(id)}/requests/${enc(rid)}`, { signal }),

  deleteRequest: (id: string, rid: string) =>
    request<void>(`/endpoints/${enc(id)}/requests/${enc(rid)}`, { method: 'DELETE' }),

  clearEndpoint: (id: string) =>
    request<void>(`/endpoints/${enc(id)}/requests`, { method: 'DELETE' }),
};
