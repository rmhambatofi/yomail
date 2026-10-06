import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ContentKind, RequestDetail } from '@yomail/shared';
import { expiresIn, formatBytes, fullDate, relativeTime } from '../lib/format';
import { MethodBadge } from './Badges';
import { CopyButton } from './CopyButton';
import { btnDanger, btnSecondary, ErrorBanner, Spinner } from './Feedback';
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

/** Right-hand side of the inbox: details, headers, query parameters and the content viewer. */
export function RequestPanel({
  state,
  endpointUrl,
  onDelete,
  onBack,
}: {
  state: PanelState;
  endpointUrl: string;
  onDelete: (id: string) => void;
  onBack: () => void;
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
        <RequestBody request={state.request} endpointUrl={endpointUrl} onDelete={onDelete} />
      )}
    </div>
  );
}

function Placeholder({ children }: { children: string }) {
  return <p className="p-8 text-center text-sm text-slate-500">{children}</p>;
}

function RequestBody({
  request,
  endpointUrl,
  onDelete,
}: {
  request: RequestDetail;
  endpointUrl: string;
  onDelete: (id: string) => void;
}) {
  const query = request.query_params
    ? '?' + new URLSearchParams(request.query_params).toString()
    : '';
  const fullUrl = `${endpointUrl}${request.path === '/' ? '' : request.path}${query}`;
  const host = request.headers.find(([n]) => n.toLowerCase() === 'host')?.[1] ?? '—';

  return (
    <div className="divide-y divide-slate-200">
      <Section
        title="Request Details & Headers"
        actions={
          <button type="button" onClick={() => onDelete(request.id)} className={btnDanger}>
            Delete
          </button>
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
