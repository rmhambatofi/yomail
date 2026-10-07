import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { OwnedEndpointSummary } from '@yomail/shared';
import { extractEndpointId, shortEndpointId } from '@yomail/shared';
import { api } from '../api/client';
import { btnPrimary, btnSecondary, ErrorBanner, Spinner } from '../components/Feedback';
import { Layout } from '../components/Layout';
import { PUBLIC_BASE_URL } from '../config';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { forgetEndpoint, listRecentEndpoints } from '../lib/recentEndpoints';
import { useAsync } from '../lib/useAsync';

export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const loader = useCallback((signal: AbortSignal) => api.health(signal), []);
  const health = useAsync(loader);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [openValue, setOpenValue] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);
  const [recents, setRecents] = useState(listRecentEndpoints);
  const [ownedIds, setOwnedIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    document.title = 'yomail — webhook catcher';
  }, []);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createEndpoint();
      navigate(`/inbox/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  const open = (e: FormEvent) => {
    e.preventDefault();
    const id = extractEndpointId(openValue);
    if (!id) {
      setOpenError('That does not look like an endpoint id or URL.');
      return;
    }
    navigate(`/inbox/${id}`);
  };

  const forget = (id: string) => {
    forgetEndpoint(id);
    setRecents(listRecentEndpoints());
  };

  const days = user ? health.data?.retention_days_members : health.data?.retention_days;
  // Signed in: "My endpoints" is the main list; the browser's recents only add what is not owned.
  const visibleRecents = user ? recents.filter((r) => !ownedIds.has(r.id)) : recents;

  return (
    <Layout>
      <section className="mx-auto max-w-xl py-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Catch any webhook, instantly.
        </h1>
        <p className="mt-2 text-slate-600">
          Create an endpoint, send any HTTP request to{' '}
          <span className="font-mono text-slate-800">{PUBLIC_BASE_URL}/&lt;id&gt;</span> and watch
          it appear here in real time. No sign-up needed.
        </p>

        <div className="mt-8 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <button
            type="button"
            onClick={create}
            disabled={creating}
            className={`${btnPrimary} w-full py-2.5`}
          >
            {creating ? 'Creating…' : 'Create endpoint'}
          </button>
          {createError && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {createError}
            </p>
          )}

          <form onSubmit={open} className="mt-5">
            <label htmlFor="open-endpoint" className="block text-sm font-medium text-slate-700">
              Open an existing endpoint
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="open-endpoint"
                type="text"
                value={openValue}
                onChange={(e) => {
                  setOpenValue(e.target.value);
                  setOpenError(null);
                }}
                placeholder="Endpoint id or full URL"
                className="w-full min-w-0 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-sm focus:border-sky-500 focus:outline-none"
                spellCheck={false}
              />
              <button type="submit" className={btnSecondary}>
                Open
              </button>
            </div>
            {openError && (
              <p className="mt-1 text-sm text-red-700" role="alert">
                {openError}
              </p>
            )}
          </form>
        </div>

        {user && <MyEndpoints onLoaded={(ids) => setOwnedIds(new Set(ids))} />}

        {visibleRecents.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold text-slate-700">
              {user ? 'Other recent endpoints' : 'Recent endpoints'}
            </h2>
            <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {visibleRecents.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <Link
                    to={`/inbox/${r.id}`}
                    className="min-w-0 truncate font-mono text-sm text-sky-700 hover:underline"
                  >
                    {shortEndpointId(r.id)}… <span className="text-slate-400">{r.id.slice(8)}</span>
                  </Link>
                  <span className="shrink-0 text-xs text-slate-500">
                    opened {relativeTime(r.openedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => forget(r.id)}
                    className="shrink-0 text-xs text-slate-400 hover:text-red-700"
                    aria-label={`Forget ${shortEndpointId(r.id)}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-400">Stored in this browser only.</p>
          </div>
        )}

        <ul className="mt-6 space-y-1 text-sm text-slate-500">
          <li>Every method is accepted: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS.</li>
          <li>JSON, forms, HTML, XML and text bodies are shown in a view that fits their type.</li>
          <li>Files and binary bodies are not stored.</li>
          <li>
            Requests are deleted automatically after{' '}
            {days !== undefined ? `${days} day${days === 1 ? '' : 's'}` : 'a few days'}
            {user ? ' on your endpoints' : ''}.
          </li>
          <li>Anyone who knows the endpoint id can read its requests.</li>
          {!user && (
            <li>
              <Link to="/signup" className="text-sky-700 hover:underline">
                Create a free account
              </Link>{' '}
              to keep a private list of your endpoints (only you can read them), name them,
              configure their response, annotate and replay requests, with a longer retention.
            </li>
          )}
        </ul>
        {health.error && (
          <p className="mt-4 text-sm text-red-700" role="alert">
            The service is unreachable right now ({health.error.message}).
          </p>
        )}
        {health.data?.db === 'error' && (
          <p className="mt-4 text-sm text-amber-700" role="alert">
            The service is degraded: new requests may not appear until it recovers.
          </p>
        )}
      </section>
    </Layout>
  );
}

/** "My endpoints" (phase 8): the endpoints owned by the signed-in user, most active first. */
function MyEndpoints({ onLoaded }: { onLoaded: (ids: string[]) => void }) {
  const loader = useCallback((signal: AbortSignal) => api.myEndpoints(signal), []);
  const mine = useAsync(loader);
  const endpoints = mine.data?.endpoints;

  useEffect(() => {
    if (endpoints) onLoaded(endpoints.map((e) => e.id));
  }, [endpoints, onLoaded]);

  return (
    <div className="mt-6" data-testid="my-endpoints">
      <h2 className="text-sm font-semibold text-slate-700">My endpoints</h2>
      {mine.loading && !endpoints && <Spinner label="Loading your endpoints…" />}
      {mine.error && (
        <div className="mt-2">
          <ErrorBanner onRetry={mine.reload}>
            Could not load your endpoints: {mine.error.message}
          </ErrorBanner>
        </div>
      )}
      {endpoints && endpoints.length === 0 && (
        <p className="mt-2 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          No endpoint yet. Endpoints you create while signed in are listed here; you can also
          claim an existing one from its inbox.
        </p>
      )}
      {endpoints && endpoints.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {endpoints.map((e) => (
            <OwnedRow key={e.id} endpoint={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OwnedRow({ endpoint }: { endpoint: OwnedEndpointSummary }) {
  const activity = endpoint.last_request_at
    ? `last request ${relativeTime(endpoint.last_request_at)}`
    : `created ${relativeTime(endpoint.created_at)}`;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <Link to={`/inbox/${endpoint.id}`} className="min-w-0 flex-1 hover:underline">
        <span className="block truncate text-sm font-medium text-sky-700">
          {endpoint.name ?? `${shortEndpointId(endpoint.id)}…`}
        </span>
        <span className="block truncate font-mono text-xs text-slate-400">{endpoint.id}</span>
      </Link>
      <span className="shrink-0 text-right text-xs text-slate-500">
        <span className="block">
          {endpoint.request_count} request{endpoint.request_count === 1 ? '' : 's'}
        </span>
        <span className="block">{activity}</span>
      </span>
    </li>
  );
}
