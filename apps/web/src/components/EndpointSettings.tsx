import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { EndpointDetail, Pair, ResponseConfig } from '@yomail/shared';
import {
  DEFAULT_RESPONSE_CONFIG,
  ENDPOINT_NAME_MAX_LENGTH,
  RESPONSE_BODY_MAX_LENGTH,
  RESPONSE_FORBIDDEN_HEADERS,
  RESPONSE_MAX_DELAY_MS,
  RESPONSE_MAX_HEADERS,
} from '@yomail/shared';
import { api } from '../api/client';
import { Field, FormError, FormNotice, describeAuthError, fieldErrors } from './AuthForm';
import { btnDanger, btnPrimary, btnSecondary } from './Feedback';

/**
 * Owner-only panel under the inbox header (phase 8): the endpoint name and the response
 * its capture URL sends back. Every save goes through PATCH /api/endpoints/:id and hands
 * the fresh EndpointDetail back to the page.
 */
export function EndpointSettings({
  endpoint,
  onSaved,
  onClose,
}: {
  endpoint: EndpointDetail;
  onSaved: (detail: EndpointDetail) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      data-testid="endpoint-settings"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800">Endpoint settings</h2>
        <button type="button" onClick={onClose} className={btnSecondary}>
          Close
        </button>
      </div>
      <NameForm endpoint={endpoint} onSaved={onSaved} />
      <ResponseForm endpoint={endpoint} onSaved={onSaved} />
    </div>
  );
}

function NameForm({
  endpoint,
  onSaved,
}: {
  endpoint: EndpointDetail;
  onSaved: (detail: EndpointDetail) => void;
}) {
  const [name, setName] = useState(endpoint.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const fields = fieldErrors(error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const trimmed = name.trim();
      const detail = await api.updateEndpoint(endpoint.id, { name: trimmed === '' ? null : trimmed });
      setName(detail.name ?? '');
      onSaved(detail);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <Field
        id="endpoint-name"
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={ENDPOINT_NAME_MAX_LENGTH}
        placeholder="e.g. Stripe test webhooks"
        hint="Shown instead of the id in your endpoint list. Leave empty to remove it."
        error={fields.name}
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
        {saved && <span className="text-sm text-emerald-700">Saved.</span>}
      </div>
      {error ? <FormError>{describeAuthError(error)}</FormError> : null}
    </form>
  );
}

const COMMON_CONTENT_TYPES = [
  'application/json',
  'text/plain',
  'text/html',
  'application/xml',
  'application/x-www-form-urlencoded',
];

interface HeaderRow {
  name: string;
  value: string;
}

function toRows(pairs: Pair[]): HeaderRow[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

/** The response the capture URL sends back (phase 8.2). */
function ResponseForm({
  endpoint,
  onSaved,
}: {
  endpoint: EndpointDetail;
  onSaved: (detail: EndpointDetail) => void;
}) {
  const initial = endpoint.response ?? DEFAULT_RESPONSE_CONFIG;
  const [status, setStatus] = useState(String(initial.status));
  const [contentType, setContentType] = useState(initial.content_type);
  const [delay, setDelay] = useState(String(initial.delay_ms));
  const [body, setBody] = useState(initial.body);
  const [headers, setHeaders] = useState<HeaderRow[]>(toRows(initial.headers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fields = fieldErrors(error);
  const headerError = Object.entries(fields).find(([k]) => k.startsWith('response.headers'))?.[1];

  // Another endpoint, or a reset from elsewhere: start again from what the server holds.
  useEffect(() => {
    const next = endpoint.response ?? DEFAULT_RESPONSE_CONFIG;
    setStatus(String(next.status));
    setContentType(next.content_type);
    setDelay(String(next.delay_ms));
    setBody(next.body);
    setHeaders(toRows(next.headers));
  }, [endpoint.id, endpoint.response]);

  const save = async (response: ResponseConfig | null) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      onSaved(await api.updateEndpoint(endpoint.id, { response }));
      setNotice(response ? 'Custom response saved.' : 'Back to the default response.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      status: Number(status),
      content_type: contentType,
      body,
      delay_ms: Number(delay),
      headers: headers
        .filter((h) => h.name.trim() !== '' || h.value !== '')
        .map((h): Pair => [h.name.trim(), h.value]),
    });
  };

  const setRow = (i: number, patch: Partial<HeaderRow>) =>
    setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setHeaders((rows) => rows.filter((_, j) => j !== i));
  const addRow = () => setHeaders((rows) => [...rows, { name: '', value: '' }]);

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 border-t border-slate-200 pt-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">Response</h3>
        <p className="mt-1 text-xs text-slate-500">
          What callers of your endpoint URL receive.{' '}
          {endpoint.response
            ? 'A custom response is active.'
            : 'The default answers 200 with {"ok":true,"id":"…"}.'}{' '}
          Every response keeps the open CORS headers and is sandboxed in browsers.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          id="response-status"
          label="Status"
          type="number"
          min={100}
          max={599}
          required
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          error={fields['response.status']}
        />
        <Field
          id="response-content-type"
          label="Content-Type"
          list="response-content-types"
          required
          value={contentType}
          onChange={(e) => setContentType(e.target.value)}
          error={fields['response.content_type']}
        />
        <datalist id="response-content-types">
          {COMMON_CONTENT_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <Field
          id="response-delay"
          label="Delay (ms)"
          type="number"
          min={0}
          max={RESPONSE_MAX_DELAY_MS}
          required
          value={delay}
          onChange={(e) => setDelay(e.target.value)}
          hint={`0 to ${RESPONSE_MAX_DELAY_MS} ms, after the request is stored`}
          error={fields['response.delay_ms']}
        />
      </div>
      <div>
        <label htmlFor="response-body" className="block text-sm font-medium text-slate-700">
          Body
        </label>
        <textarea
          id="response-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={RESPONSE_BODY_MAX_LENGTH}
          rows={5}
          spellCheck={false}
          className={`mt-1 w-full rounded-md border px-3 py-1.5 font-mono text-xs focus:outline-none ${
            fields['response.body']
              ? 'border-red-400 focus:border-red-500'
              : 'border-slate-300 focus:border-sky-500'
          }`}
        />
        {fields['response.body'] && (
          <p className="mt-1 text-xs text-red-700">{fields['response.body']}</p>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">Headers</span>
          <button
            type="button"
            onClick={addRow}
            disabled={headers.length >= RESPONSE_MAX_HEADERS}
            className={btnSecondary}
          >
            Add header
          </button>
        </div>
        {headers.length === 0 && (
          <p className="mt-1 text-xs text-slate-500">
            No custom header. Content-Type, Set-Cookie, CORS and framing headers (
            {RESPONSE_FORBIDDEN_HEADERS.length} names) cannot be set here.
          </p>
        )}
        <ul className="mt-1 space-y-1">
          {headers.map((h, i) => (
            <li key={i} className="flex gap-2">
              <input
                aria-label={`Header ${i + 1} name`}
                value={h.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder="X-Request-Id"
                spellCheck={false}
                className="w-2/5 min-w-0 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs focus:border-sky-500 focus:outline-none"
              />
              <input
                aria-label={`Header ${i + 1} value`}
                value={h.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="value"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs focus:border-sky-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="shrink-0 px-1 text-slate-400 hover:text-red-700"
                aria-label={`Remove header ${i + 1}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        {headerError && <p className="mt-1 text-xs text-red-700">{headerError}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={btnPrimary} data-testid="save-response">
          {busy ? 'Saving…' : 'Save response'}
        </button>
        {endpoint.response && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className={btnDanger}
            data-testid="reset-response"
          >
            Reset to default
          </button>
        )}
        {notice && <span className="text-sm text-emerald-700">{notice}</span>}
      </div>
      {error ? <FormError>{describeAuthError(error)}</FormError> : null}
      {!error && !notice && fields._ ? <FormNotice>{fields._}</FormNotice> : null}
    </form>
  );
}
