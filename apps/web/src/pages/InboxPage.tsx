import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EndpointDetail, RequestDetail } from '@yomail/shared';
import { extractEndpointId, shortEndpointId } from '@yomail/shared';
import { ApiError, api } from '../api/client';
import { describeAuthError } from '../components/AuthForm';
import { LiveBadge } from '../components/Badges';
import { CopyButton } from '../components/CopyButton';
import { EndpointPicker } from '../components/EndpointPicker';
import { EndpointSettings } from '../components/EndpointSettings';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  EmptyState,
  ErrorBanner,
  Spinner,
} from '../components/Feedback';
import { Layout } from '../components/Layout';
import {
  EMPTY_FILTER,
  RequestFilter,
  filterRequests,
  isFilterActive,
} from '../components/RequestFilter';
import type { RequestFilterValue } from '../components/RequestFilter';
import { RequestList } from '../components/RequestList';
import { RequestPanel } from '../components/RequestPanel';
import type { PanelState } from '../components/RequestPanel';
import { PUBLIC_BASE_URL } from '../config';
import { useAuth } from '../lib/auth';
import { forgetEndpoint, rememberEndpoint } from '../lib/recentEndpoints';
import { useLiveRequests } from '../lib/useLiveRequests';

/**
 * One screen for /inbox/:uuid and /inbox/:uuid/:rid. The list and the detail panel live
 * side by side on desktop; on mobile the URL decides which one is visible (a :rid shows
 * the panel, "Back to inbox" drops it) without unmounting the live subscription.
 */
export function InboxPage() {
  const params = useParams<{ uuid: string; rid?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const endpointId = params.uuid ? extractEndpointId(params.uuid) : null;
  const rid = params.rid ?? null;
  const url = endpointId ? `${PUBLIC_BASE_URL}/${endpointId}` : '';

  // Canonical URL: lowercase id (and nothing else accepted).
  useEffect(() => {
    if (endpointId && params.uuid !== endpointId) {
      navigate(`/inbox/${endpointId}${rid ? `/${rid}` : ''}`, { replace: true });
    }
  }, [endpointId, params.uuid, rid, navigate]);

  const live = useLiveRequests(endpointId);
  const { endpoint, setEndpoint } = useEndpointDetail(
    endpointId,
    user?.id ?? null,
    live.generation,
  );
  const owned = endpoint?.owned ?? false;
  const canDelete = endpoint ? owned || !endpoint.has_owner : false;
  const canClaim = !!user && !!endpoint && !endpoint.has_owner;
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const label = endpoint?.name ?? (endpointId ? shortEndpointId(endpointId) : null);
    document.title = label ? `${label} — yomail inbox` : 'Endpoint not found — yomail';
  }, [endpointId, endpoint?.name]);

  useEffect(() => {
    if (endpointId && live.status === 'ready') rememberEndpoint(endpointId);
    if (endpointId && live.status === 'not-found') forgetEndpoint(endpointId);
    // Another member's endpoint will never open here again; an endpoint we may own once
    // signed in stays in the recents.
    if (endpointId && live.status === 'forbidden' && live.denied === 'not-owner')
      forgetEndpoint(endpointId);
  }, [endpointId, live.status, live.denied]);

  // Client-side filter (members, phase 8.3) over the loaded requests.
  const [filter, setFilter] = useState<RequestFilterValue>(EMPTY_FILTER);
  const filtering = !!user && isFilterActive(filter);
  const visible = filtering ? filterRequests(live.requests, filter) : live.requests;
  const methods = [...new Set(live.requests.map((r) => r.method))].sort();

  // Desktop auto-selects the newest request when the URL names none.
  const selectedId = rid ?? visible[0]?.id ?? null;
  const { state: panel, update: updateDetail } = useRequestDetail(endpointId, selectedId);

  const select = (id: string) => navigate(`/inbox/${endpointId}/${id}`);
  const back = () => navigate(`/inbox/${endpointId}`);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteRequest = (id: string) =>
    run(async () => {
      if (!endpointId) return;
      await api.deleteRequest(endpointId, id);
      const index = live.requests.findIndex((r) => r.id === id);
      const next = live.requests[index + 1] ?? live.requests[index - 1];
      live.removeLocal(id);
      if (rid === id)
        navigate(next ? `/inbox/${endpointId}/${next.id}` : `/inbox/${endpointId}`, {
          replace: true,
        });
    });

  const clearInbox = () => {
    if (!endpointId || !window.confirm('Delete every request in this inbox?')) return;
    void run(async () => {
      await api.clearEndpoint(endpointId);
      live.clearLocal();
      if (rid) navigate(`/inbox/${endpointId}`, { replace: true });
    });
  };

  const deleteEndpoint = () => {
    if (
      !endpointId ||
      !window.confirm('Delete this endpoint and all its requests? The URL will stop working.')
    )
      return;
    void run(async () => {
      await api.deleteEndpoint(endpointId);
      forgetEndpoint(endpointId);
      navigate('/', { replace: true });
    });
  };

  const claimEndpoint = () =>
    run(async () => {
      if (!endpointId) return;
      setEndpoint(await api.claimEndpoint(endpointId));
    });

  const newEndpoint = () =>
    run(async () => {
      const created = await api.createEndpoint();
      navigate(`/inbox/${created.id}`);
    });

  if (endpointId && live.status === 'forbidden') {
    const signIn = `/login?next=${encodeURIComponent(`/inbox/${endpointId}`)}`;
    return (
      <Layout>
        <div className="mx-auto max-w-xl py-12" data-testid="private-endpoint">
          <EmptyState title="This endpoint is private">
            {live.denied === 'unauthenticated'
              ? 'It belongs to a member. Sign in as its owner to see its requests.'
              : 'It belongs to another member. Only its owner can see its requests.'}
          </EmptyState>
          <div className="mt-4 flex flex-wrap gap-2">
            {live.denied === 'unauthenticated' && (
              <Link to={signIn} className={btnPrimary} data-testid="private-sign-in">
                Sign in
              </Link>
            )}
            <button
              type="button"
              onClick={newEndpoint}
              disabled={busy}
              className={live.denied === 'unauthenticated' ? btnSecondary : btnPrimary}
            >
              Create a new endpoint
            </button>
            <Link to="/" className={btnSecondary}>
              Home
            </Link>
          </div>
          {actionError && <p className="mt-3 text-sm text-red-700">{actionError}</p>}
        </div>
      </Layout>
    );
  }

  if (!endpointId || live.status === 'not-found') {
    return (
      <Layout>
        <div className="mx-auto max-w-xl py-12">
          <EmptyState title="This endpoint does not exist or has expired">
            Endpoints are deleted after {live.retentionDays ?? 'a few'} days without requests.
          </EmptyState>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={newEndpoint} disabled={busy} className={btnPrimary}>
              Create a new endpoint
            </button>
            <Link to="/" className={btnSecondary}>
              Home
            </Link>
          </div>
          {actionError && <p className="mt-3 text-sm text-red-700">{actionError}</p>}
        </div>
      </Layout>
    );
  }

  const curl = `curl -X POST ${url} -H 'Content-Type: application/json' -d '{"hello":"world"}'`;
  const total = `${live.requests.length}${live.hasMore ? '+' : ''}`;
  const count = filtering ? `${visible.length} of ${total}` : total;

  return (
    <Layout wide>
      <header className="mb-4 space-y-3">
        {endpoint?.name && (
          <h1
            className="truncate text-xl font-semibold tracking-tight text-slate-900"
            data-testid="endpoint-name"
          >
            {endpoint.name}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 break-all font-mono text-sm font-semibold text-slate-900 sm:text-base">
            {url}
          </p>
          <CopyButton value={url} label="Copy URL" />
          <LiveBadge status={live.live} />
          {owned && (
            <span
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
              title="You own this endpoint: only you can see, configure or delete it"
              data-testid="owner-badge"
            >
              Yours
            </span>
          )}
          {endpoint?.custom_response && (
            <span
              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
              title="The owner configured what this URL answers (status, headers, body, delay)"
              data-testid="custom-response-badge"
            >
              Custom response
            </span>
          )}
        </div>
        {endpoint && (
          <p className="text-xs text-slate-500" data-testid="endpoint-limits">
            Requests are kept {endpoint.retention_days} day{endpoint.retention_days === 1 ? '' : 's'},
            up to {endpoint.max_requests.toLocaleString()} per endpoint
            {endpoint.has_owner ? ' (member limits)' : user ? ' (claim it for member limits)' : ''}.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <EndpointPicker currentId={endpointId} />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={newEndpoint} disabled={busy} className={btnSecondary}>
              New endpoint
            </button>
            {owned && (
              <button
                type="button"
                onClick={() => setSettingsOpen((o) => !o)}
                className={btnSecondary}
                aria-expanded={settingsOpen}
                data-testid="edit-endpoint"
              >
                {settingsOpen ? 'Close settings' : 'Edit'}
              </button>
            )}
            {canClaim && (
              <button
                type="button"
                onClick={claimEndpoint}
                disabled={busy}
                className={btnSecondary}
                title="Make this endpoint yours: it becomes private to you, joins your list, and only you can configure or delete it"
                data-testid="claim-endpoint"
              >
                Claim this endpoint
              </button>
            )}
            <button
              type="button"
              onClick={clearInbox}
              disabled={busy || live.requests.length === 0}
              className={btnSecondary}
            >
              Clear inbox
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={deleteEndpoint}
                disabled={busy}
                className={btnDanger}
                data-testid="delete-endpoint"
              >
                Delete endpoint
              </button>
            )}
          </div>
        </div>
        {settingsOpen && endpoint && owned && (
          <EndpointSettings
            endpoint={endpoint}
            onSaved={setEndpoint}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
        {live.error && live.status !== 'loading' && (
          <ErrorBanner onRetry={live.reload}>{live.error.message}</ErrorBanner>
        )}
      </header>

      {live.status === 'loading' && <Spinner label="Loading inbox…" />}
      {live.status === 'error' && live.error && (
        <ErrorBanner onRetry={live.reload}>
          Could not load the inbox: {live.error.message}
        </ErrorBanner>
      )}

      {live.status === 'ready' && (
        <div className="grid gap-4 lg:h-[calc(100vh-14rem)] lg:min-h-[28rem] lg:grid-cols-3">
          <aside
            className={`rounded-lg border border-slate-200 bg-white lg:flex lg:flex-col lg:overflow-hidden ${
              rid ? 'hidden lg:block' : ''
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Inbox ({count})</span>
              <span className="font-normal normal-case tracking-normal">Newest first</span>
            </div>
            {user && live.requests.length > 0 && (
              <RequestFilter value={filter} onChange={setFilter} methods={methods} />
            )}
            <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {live.requests.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="Waiting for requests…">
                    Send any HTTP request to the endpoint URL and it will appear here.
                  </EmptyState>
                  <div className="mt-3 rounded-md bg-slate-900 p-3">
                    <code className="block break-all font-mono text-xs text-slate-100">{curl}</code>
                    <div className="mt-2">
                      <CopyButton value={curl} label="Copy example" />
                    </div>
                  </div>
                </div>
              ) : visible.length === 0 ? (
                <p className="p-4 text-center text-sm text-slate-500" data-testid="filter-empty">
                  No request matches the filter.
                </p>
              ) : (
                <RequestList
                  requests={visible}
                  selectedId={selectedId}
                  freshIds={live.freshIds}
                  hasMore={live.hasMore}
                  loadingOlder={live.loadingOlder}
                  onSelect={select}
                  onLoadOlder={live.loadOlder}
                />
              )}
            </div>
          </aside>
          <section
            className={`rounded-lg border border-slate-200 bg-white lg:col-span-2 lg:overflow-y-auto ${
              rid ? '' : 'hidden lg:block'
            }`}
            aria-label="Request details"
          >
            <RequestPanel
              state={panel}
              endpointId={endpointId}
              endpointUrl={url}
              access={{ signedIn: !!user, owned }}
              onDelete={deleteRequest}
              onBack={back}
              onUpdated={updateDetail}
            />
          </section>
        </div>
      )}
    </Layout>
  );
}

/**
 * Endpoint metadata (name, ownership, configured response). Re-fetched when the endpoint,
 * the signed-in user (`owned` depends on the session) or the live generation changes
 * (reload, endpoint claimed); PATCH/claim results replace it in place through `setEndpoint`.
 */
function useEndpointDetail(
  endpointId: string | null,
  userId: string | null,
  generation: number,
): { endpoint: EndpointDetail | null; setEndpoint: (detail: EndpointDetail) => void } {
  const [endpoint, setEndpoint] = useState<EndpointDetail | null>(null);

  useEffect(() => {
    setEndpoint(null);
    if (!endpointId) return;
    const ctrl = new AbortController();
    api
      .endpoint(endpointId, ctrl.signal)
      .then((detail) => {
        if (!ctrl.signal.aborted) setEndpoint(detail);
      })
      .catch(() => {
        // 404, 401/403 and network errors: the live hook already reports them.
      });
    return () => ctrl.abort();
  }, [endpointId, userId, generation]);

  return { endpoint, setEndpoint };
}

/** Loads the selected request's detail and caches it by id for the life of the page. */
function useRequestDetail(
  endpointId: string | null,
  id: string | null,
): { state: PanelState; update: (detail: RequestDetail) => void } {
  const cache = useRef(new Map<string, RequestDetail>());
  const [state, setState] = useState<PanelState>({ kind: 'empty' });
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!endpointId || !id) {
      setState({ kind: 'empty' });
      return;
    }
    const cached = cache.current.get(id);
    if (cached) {
      setState({ kind: 'ready', request: cached });
      return;
    }
    const ctrl = new AbortController();
    setState({ kind: 'loading' });
    api
      .request(endpointId, id, ctrl.signal)
      .then((detail) => {
        cache.current.set(id, detail);
        setState({ kind: 'ready', request: detail });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'not-found' });
        else
          setState({
            kind: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
            retry,
          });
      });
    return () => ctrl.abort();
  }, [endpointId, id, tick, retry]);

  // A PATCH (note) returned a fresh detail: keep cache and panel in sync.
  const update = useCallback((detail: RequestDetail) => {
    cache.current.set(detail.id, detail);
    setState((s) =>
      s.kind === 'ready' && s.request.id === detail.id ? { kind: 'ready', request: detail } : s,
    );
  }, []);

  return { state, update };
}
