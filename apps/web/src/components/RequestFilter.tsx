import type { RequestSummary } from '@yomail/shared';
import { shortRequestId } from '@yomail/shared';

export interface RequestFilterValue {
  /** Free text matched against method, path, client IP and short id (case-insensitive). */
  text: string;
  /** Exact method, or '' for every method. */
  method: string;
}

export const EMPTY_FILTER: RequestFilterValue = { text: '', method: '' };

export function isFilterActive(value: RequestFilterValue): boolean {
  return value.text.trim() !== '' || value.method !== '';
}

/** Client-side filter over the loaded requests (phase 8.3); no API call involved. */
export function filterRequests(
  requests: RequestSummary[],
  value: RequestFilterValue,
): RequestSummary[] {
  if (!isFilterActive(value)) return requests;
  const needle = value.text.trim().toLowerCase();
  return requests.filter((r) => {
    if (value.method && r.method !== value.method) return false;
    if (!needle) return true;
    return (
      r.method.toLowerCase().includes(needle) ||
      r.path.toLowerCase().includes(needle) ||
      (r.client_ip ?? '').toLowerCase().includes(needle) ||
      shortRequestId(r.id).toLowerCase().includes(needle) ||
      r.id.startsWith(needle)
    );
  });
}

export function RequestFilter({
  value,
  onChange,
  methods,
}: {
  value: RequestFilterValue;
  onChange: (value: RequestFilterValue) => void;
  /** Methods present in the list, for the select. */
  methods: string[];
}) {
  return (
    <div className="flex gap-2 border-b border-slate-200 px-3 py-2" data-testid="request-filter">
      <input
        type="search"
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="Filter by path, IP, id…"
        aria-label="Filter requests"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-sky-500 focus:outline-none"
      />
      <select
        value={value.method}
        onChange={(e) => onChange({ ...value, method: e.target.value })}
        aria-label="Filter by method"
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-sky-500 focus:outline-none"
      >
        <option value="">Any method</option>
        {methods.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      {isFilterActive(value) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTER)}
          className="text-xs text-slate-500 hover:text-slate-800"
          aria-label="Clear filter"
        >
          ✕
        </button>
      )}
    </div>
  );
}
