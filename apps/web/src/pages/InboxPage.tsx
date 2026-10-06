import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RequestDetail } from '@yomail/shared';
import { extractEndpointId, shortEndpointId } from '@yomail/shared';
import { ApiError, api } from '../api/client';
import { LiveBadge } from '../components/Badges';
import { CopyButton } from '../components/CopyButton';
import { EndpointPicker } from '../components/EndpointPicker';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  EmptyState,
  ErrorBanner,
  Spinner,
} from '../components/Feedback';
import { Layout } from '../components/Layout';
import { RequestList } from '../components/RequestList';
import { RequestPanel } from '../components/RequestPanel';
import type { PanelState } from '../components/RequestPanel';
import { PUBLIC_BASE_URL } from '../config';
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

  useEffect(() => {
    document.title = endpointId
      ? `${shortEndpointId(endpointId)} — yomail inbox`
      : 'Endpoint not found — yomail';
  }, [endpointId]);

  useEffect(() => {
    if (endpointId && live.status === 'ready') rememberEndpoint(endpointId);
    if (endpointId && live.status === 'not-found') forgetEndpoint(endpointId);
  }, [endpointId, live.status]);

  // Desktop auto-selects the newest request when the URL names none.
  const selectedId = rid ?? live.requests[0]?.id ?? null;
  const panel = useRequestDetail(endpointId, selectedId);

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
      setActionError(err instanceof Error ? err.message : String(err));
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

  const newEndpoint = () =>
    run(async () => {
      const created = await api.createEndpoint();
      navigate(`/inbox/${created.id}`);
    });

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
  const count = `${live.requests.length}${live.hasMore ? '+' : ''}`;

  return (
    <Layout wide>
      <header className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 break-all font-mono text-sm font-semibold text-slate-900 sm:text-base">
            {url}
          </h1>
          <CopyButton value={url} label="Copy URL" />
          <LiveBadge status={live.live} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <EndpointPicker currentId={endpointId} />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={newEndpoint} disabled={busy} className={btnSecondary}>
              New endpoint
            </button>
            <button
              type="button"
              onClick={clearInbox}
              disabled={busy || live.requests.length === 0}
              className={btnSecondary}
            >
              Clear inbox
            </button>
            <button type="button" onClick={deleteEndpoint} disabled={busy} className={btnDanger}>
              Delete endpoint
            </button>
          </div>
        </div>
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
              ) : (
                <RequestList
                  requests={live.requests}
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
            <RequestPanel state={panel} endpointUrl={url} onDelete={deleteRequest} onBack={back} />
          </section>
        </div>
      )}
    </Layout>
  );
}

/** Loads the selected request's detail and caches it by id for the life of the page. */
function useRequestDetail(endpointId: string | null, id: string | null): PanelState {
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

  return state;
}
