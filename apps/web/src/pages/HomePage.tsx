import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { extractEndpointId, shortEndpointId } from '@yomail/shared';
import { api } from '../api/client';
import { btnPrimary, btnSecondary } from '../components/Feedback';
import { Layout } from '../components/Layout';
import { PUBLIC_BASE_URL } from '../config';
import { relativeTime } from '../lib/format';
import { forgetEndpoint, listRecentEndpoints } from '../lib/recentEndpoints';
import { useAsync } from '../lib/useAsync';

export function HomePage() {
  const navigate = useNavigate();
  const loader = useCallback((signal: AbortSignal) => api.health(signal), []);
  const health = useAsync(loader);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [openValue, setOpenValue] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);
  const [recents, setRecents] = useState(listRecentEndpoints);

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

  const days = health.data?.retention_days;

  return (
    <Layout>
      <section className="mx-auto max-w-xl py-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Catch any webhook, instantly.
        </h1>
        <p className="mt-2 text-slate-600">
          Create an endpoint, send any HTTP request to{' '}
          <span className="font-mono text-slate-800">{PUBLIC_BASE_URL}/&lt;id&gt;</span> and watch
          it appear here in real time. No sign-up, no password.
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

        {recents.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold text-slate-700">Recent endpoints</h2>
            <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {recents.map((r) => (
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
          <li>Every method is accepted: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD.</li>
          <li>JSON, forms, HTML, XML and text bodies are shown in a view that fits their type.</li>
          <li>Files and binary bodies are not stored.</li>
          <li>
            Requests are deleted automatically after{' '}
            {days !== undefined ? `${days} day${days === 1 ? '' : 's'}` : 'a few days'}.
          </li>
          <li>Anyone who knows the endpoint id can read its requests.</li>
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
