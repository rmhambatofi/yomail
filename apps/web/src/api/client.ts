import type {
  AccountEndpointsResponse,
  AuthErrorCode,
  ChangePasswordRequest,
  EndpointDetail,
  EndpointSummary,
  HealthStatus,
  LoginRequest,
  OkResponse,
  ReplayResult,
  RequestDetail,
  RequestListResponse,
  SignupRequest,
  UpdateEndpointRequest,
  UserProfile,
} from '@yomail/shared';
import { API_URL } from '../config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Machine-readable code of the auth/account routes (branch on it, not on message). */
    public readonly code?: AuthErrorCode,
    /** Field -> problem, for 400 VALIDATION */
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The only place that calls fetch. Throws ApiError with the HTTP status so pages can
 * special-case 400/404/401. Cookies: same-origin by default (the SPA, the API and the
 * Vite proxy share one origin), so the session cookie travels without extra options.
 */
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
  let code: AuthErrorCode | undefined;
  let fields: Record<string, string> | undefined;
  try {
    const body = (await res.json()) as {
      message?: string | string[];
      code?: AuthErrorCode;
      fields?: Record<string, string>;
    };
    if (body.message)
      message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    code = body.code;
    fields = body.fields;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message, code, fields);
}

const enc = encodeURIComponent;

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

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

  // ---- accounts (phase 7) ----
  signup: (body: SignupRequest) => request<OkResponse>('/auth/signup', json('POST', body)),
  confirm: (token: string) => request<UserProfile>('/auth/confirm', json('POST', { token })),
  resendConfirmation: (email: string) =>
    request<OkResponse>('/auth/resend-confirmation', json('POST', { email })),
  login: (body: LoginRequest) => request<UserProfile>('/auth/login', json('POST', body)),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: (signal?: AbortSignal) => request<UserProfile>('/auth/me', { signal }),
  forgotPassword: (email: string) =>
    request<OkResponse>('/auth/forgot-password', json('POST', { email })),
  resetPassword: (token: string, password: string) =>
    request<void>('/auth/reset-password', json('POST', { token, password })),
  changePassword: (body: ChangePasswordRequest) =>
    request<void>('/account/password', json('PATCH', body)),
  deleteAccount: (password: string) => request<void>('/account', json('DELETE', { password })),

  // ---- member features (phase 8) ----
  myEndpoints: (signal?: AbortSignal) =>
    request<AccountEndpointsResponse>('/account/endpoints', { signal }),
  updateEndpoint: (id: string, body: UpdateEndpointRequest) =>
    request<EndpointDetail>(`/endpoints/${enc(id)}`, json('PATCH', body)),
  claimEndpoint: (id: string) =>
    request<EndpointDetail>(`/endpoints/${enc(id)}/claim`, { method: 'POST' }),
  updateNote: (id: string, rid: string, note: string | null) =>
    request<RequestDetail>(`/endpoints/${enc(id)}/requests/${enc(rid)}`, json('PATCH', { note })),
  replay: (id: string, rid: string, targetUrl: string) =>
    request<ReplayResult>(
      `/endpoints/${enc(id)}/requests/${enc(rid)}/replay`,
      json('POST', { target_url: targetUrl }),
    ),
};
