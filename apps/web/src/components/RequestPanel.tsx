import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ContentKind, ReplayResult, RequestDetail } from '@yomail/shared';
import { NOTE_MAX_LENGTH } from '@yomail/shared';
import { api } from '../api/client';
import { requestUrl, toCurl } from '../lib/curl';
import { expiresIn, formatBytes, fullDate, relativeTime } from '../lib/format';
import { describeAuthError, fieldErrors } from './AuthForm';
import { MethodBadge } from './Badges';
import { CopyButton } from './CopyButton';
import { btnDanger, btnPrimary, btnSecondary, ErrorBanner, Spinner } from './Feedback';
import { HeadersTable, PairsTable } from './HeadersTable';
import { Section } from './Section';
import { FormViewer } from './viewers/FormViewer';
import { HtmlViewer } from './viewers/HtmlViewer';
import { JsonViewer } from './viewers/JsonViewer';
import { TextViewer } from './viewers/TextViewer';

export type PanelState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; error: Error; retry: () => void }
  | { kind: 'ready'; request: RequestDetail };

export interface PanelAccess {
  /** A member is signed in: client-side extras (Copy as cURL). */
  signedIn: boolean;
  /** The signed-in member owns the endpoint: note and replay. */
  owned: boolean;
}

/** Right-hand side of the inbox: details, headers, query parameters and the content viewer. */
export function RequestPanel({
  state,
  endpointId,
  endpointUrl,
  access,
  onDelete,
  onBack,
  onUpdated,
}: {
  state: PanelState;
  endpointId: string;
  endpointUrl: string;
  access: PanelAccess;
  onDelete: (id: string) => void;
  onBack: () => void;
  /** A PATCH returned a fresh detail (note): the page keeps its cache in sync. */
  onUpdated: (request: RequestDetail) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2 lg:hidden">
        <button type="button" onClick={onBack} className={btnSecondary}>
          ← Back to inbox
        </button>
      </div>
      {state.kind === 'empty' && <Placeholder>Select a request to see its details.</Placeholder>}
      {state.kind === 'loading' && <Spinner label="Loading request…" />}
      {state.kind === 'not-found' && (
        <Placeholder>Request not found. It may have been deleted or expired.</Placeholder>
      )}
      {state.kind === 'error' && (
        <div className="p-4">
          <ErrorBanner onRetry={state.retry}>
            Could not load the request: {state.error.message}
          </ErrorBanner>
        </div>
      )}
      {state.kind === 'ready' && (
        <RequestBody
          request={state.request}
          endpointId={endpointId}
          endpointUrl={endpointUrl}
          access={access}
          onDelete={onDelete}
          onUpdated={onUpdated}
        />
      )}
    </div>
  );
}

function Placeholder({ children }: { children: string }) {
  return <p className="p-8 text-center text-sm text-slate-500">{children}</p>;
}

function RequestBody({
  request,
  endpointId,
  endpointUrl,
  access,
  onDelete,
  onUpdated,
}: {
  request: RequestDetail;
  endpointId: string;
  endpointUrl: string;
  access: PanelAccess;
  onDelete: (id: string) => void;
  onUpdated: (request: RequestDetail) => void;
}) {
  const fullUrl = requestUrl(request, endpointUrl);
  const host = request.headers.find(([n]) => n.toLowerCase() === 'host')?.[1] ?? '—';

  return (
    <div className="divide-y divide-slate-200">
      <Section
        title="Request Details & Headers"
        actions={
          <>
            {access.signedIn && (
              <CopyButton value={toCurl(request, endpointUrl)} label="Copy as cURL" />
            )}
            <button type="button" onClick={() => onDelete(request.id)} className={btnDanger}>
              Delete
            </button>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <dl className="text-sm">
            <Row label={<MethodBadge method={request.method} large />}>
              <span className="flex items-start gap-2">
                <span className="break-all font-mono text-xs">{fullUrl}</span>
                <CopyButton value={fullUrl} />
              </span>
            </Row>
            <Row label="Host">{host}</Row>
            <Row label="Client IP">
              <span className="font-mono">{request.client_ip ?? '—'}</span>
            </Row>
            <Row label="Date">
              <time dateTime={request.received_at}>{fullDate(request.received_at)}</time>{' '}
              <span className="text-slate-500">({relativeTime(request.received_at)})</span>
            </Row>
            <Row label="Size">{formatBytes(request.size_bytes)}</Row>
            <Row label="Content-Type">
              <span className="font-mono text-xs">{request.content_type ?? '—'}</span>
            </Row>
            <Row label="ID">
              <span className="flex items-start gap-2">
                <span className="break-all font-mono text-xs">{request.id}</span>
                <CopyButton value={request.id} />
              </span>
            </Row>
            <Row label="Expires">{expiresIn(request.expires_at)}</Row>
          </dl>
          <HeadersTable headers={request.headers} />
        </div>
      </Section>

      {request.query_params && request.query_params.length > 0 && (
        <Section title="Query Parameters">
          <PairsTable pairs={request.query_params} emptyLabel="No query parameters." />
        </Section>
      )}

      <Section title="Request Content">
        <ContentViewer request={request} />
      </Section>

      {(access.owned || request.note) && (
        <Section title="Note">
          <NoteEditor
            request={request}
            endpointId={endpointId}
            editable={access.owned}
            onUpdated={onUpdated}
          />
        </Section>
      )}

      {access.owned && (
        <Section title="Replay" defaultOpen={false}>
          <ReplayPanel request={request} endpointId={endpointId} />
        </Section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-t border-slate-100 py-1.5 first:border-t-0">
      <dt className="w-28 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-slate-800">{children}</dd>
    </div>
  );
}

type View = 'formatted' | 'fields' | 'preview' | 'raw';

const VIEWS: Record<ContentKind, View[]> = {
  none: [],
  binary: [],
  json: ['formatted', 'raw'],
  form: ['fields', 'raw'],
  multipart: ['fields'],
  html: ['raw', 'preview'],
  xml: ['raw'],
  text: ['raw'],
};

const VIEW_LABEL: Record<View, string> = {
  formatted: 'Formatted',
  fields: 'Fields',
  preview: 'Preview',
  raw: 'Raw',
};

function ContentViewer({ request }: { request: RequestDetail }) {
  const views = VIEWS[request.content_kind];
  const [view, setView] = useState<View | null>(views[0] ?? null);
  // A different request may have a different kind: reset the tab.
  useEffect(
    () => setView(VIEWS[request.content_kind][0] ?? null),
    [request.id, request.content_kind],
  );

  if (request.content_kind === 'none') {
    return <p className="text-sm text-slate-500">No content.</p>;
  }
  if (request.content_kind === 'binary') {
    return (
      <p className="text-sm text-slate-500">
        Binary content not stored ({request.content_type ?? 'unknown type'},{' '}
        {formatBytes(request.size_bytes)}).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {views.length > 1 && (
        <div className="flex gap-1" role="tablist">
          {views.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                view === v
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      )}
      {view === 'formatted' && request.body !== null && <JsonViewer text={request.body} />}
      {view === 'fields' && (
        <FormViewer fields={request.form_fields ?? []} droppedFiles={request.dropped_files ?? []} />
      )}
      {view === 'preview' && request.html_sanitized !== null && (
        <HtmlViewer htmlSanitized={request.html_sanitized} />
      )}
      {view === 'raw' && <TextViewer text={request.body ?? ''} />}
    </div>
  );
}

/** Owner's free text on a request (phase 8.3); read-only for other viewers when present. */
function NoteEditor({
  request,
  endpointId,
  editable,
  onUpdated,
}: {
  request: RequestDetail;
  endpointId: string;
  editable: boolean;
  onUpdated: (request: RequestDetail) => void;
}) {
  const [draft, setDraft] = useState(request.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  // The server's note is the source of truth (a save hands a fresh detail back through onUpdated).
  useEffect(() => {
    setDraft(request.note ?? '');
  }, [request.id, request.note]);
  // Another request: forget the previous outcome.
  useEffect(() => {
    setError(null);
    setSaved(false);
  }, [request.id]);

  if (!editable) {
    return (
      <p className="whitespace-pre-wrap text-sm text-slate-800" data-testid="note-text">
        {request.note}
      </p>
    );
  }

  const save = async (note: string | null) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.updateNote(endpointId, request.id, note);
      onUpdated(updated);
      setDraft(updated.note ?? '');
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(draft.trim() === '' ? null : draft);
  };

  const dirty = draft !== (request.note ?? '');
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={NOTE_MAX_LENGTH}
        rows={3}
        placeholder="What is this request? Only you can edit this note; anyone opening the inbox can read it."
        aria-label="Note"
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
        data-testid="note-input"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !dirty} className={btnPrimary} data-testid="note-save">
          {busy ? 'Saving…' : 'Save note'}
        </button>
        {request.note && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className={btnSecondary}
          >
            Remove
          </button>
        )}
        <span className="text-xs text-slate-400">
          {draft.length}/{NOTE_MAX_LENGTH}
        </span>
        {saved && !dirty && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {fieldErrors(error).note ?? describeAuthError(error)}
        </p>
      ) : null}
    </form>
  );
}

const REPLAY_TARGET_KEY = 'yomail.replayTarget.';

function readReplayTarget(endpointId: string): string {
  try {
    return localStorage.getItem(REPLAY_TARGET_KEY + endpointId) ?? '';
  } catch {
    return '';
  }
}

function saveReplayTarget(endpointId: string, target: string): void {
  try {
    localStorage.setItem(REPLAY_TARGET_KEY + endpointId, target);
  } catch {
    /* storage unavailable */
  }
}

/** Re-sends the request to a URL of the owner's choice (phase 8.3) and shows what came back. */
function ReplayPanel({ request, endpointId }: { request: RequestDetail; endpointId: string }) {
  const [target, setTarget] = useState(() => readReplayTarget(endpointId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [request.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      saveReplayTarget(endpointId, target);
      setResult(await api.replay(endpointId, request.id, target.trim()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Sends this request again (same method, path, query, headers and body) to a public URL,
        from the yomail server. Private and local addresses are refused; redirects are not
        followed.
      </p>
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="url"
          required
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="https://example.com/webhooks/incoming"
          aria-label="Replay target URL"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs focus:border-sky-500 focus:outline-none"
          data-testid="replay-target"
        />
        <button type="submit" disabled={busy} className={btnPrimary} data-testid="replay-send">
          {busy ? 'Sending…' : 'Replay'}
        </button>
      </form>
      {error ? (
        <p className="text-sm text-red-700" role="alert" data-testid="replay-error">
          {fieldErrors(error).target_url ?? describeAuthError(error)}
        </p>
      ) : null}
      {result && (
        <div className="space-y-2 rounded-md border border-slate-200 p-3" data-testid="replay-result">
          <p className="text-sm">
            <span
              className={`rounded px-1.5 py-0.5 font-mono font-semibold text-white ${
                result.status < 300
                  ? 'bg-emerald-600'
                  : result.status < 400
                    ? 'bg-amber-600'
                    : 'bg-red-600'
              }`}
            >
              {result.status}
            </span>{' '}
            <span className="text-slate-600">in {result.duration_ms} ms</span>
            {result.truncated && (
              <span className="ml-2 text-xs text-amber-700">response body cut at 64 KB</span>
            )}
          </p>
          {result.warning && <p className="text-xs text-amber-700">{result.warning}</p>}
          <details>
            <summary className="cursor-pointer text-xs font-medium text-slate-700">
              Response headers ({result.headers.length})
            </summary>
            <div className="mt-2">
              <PairsTable pairs={result.headers} emptyLabel="No headers." />
            </div>
          </details>
          {result.body !== null ? (
            <TextViewer text={result.body} />
          ) : (
            <p className="text-xs text-slate-500">Empty response body.</p>
          )}
        </div>
      )}
    </div>
  );
}
