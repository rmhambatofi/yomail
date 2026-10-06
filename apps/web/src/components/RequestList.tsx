import type { RequestSummary } from '@yomail/shared';
import { shortRequestId } from '@yomail/shared';
import { formatBytes, fullDate, relativeTime } from '../lib/format';
import { MethodBadge } from './Badges';
import { btnSecondary } from './Feedback';

export function RequestList({
  requests,
  selectedId,
  freshIds,
  hasMore,
  loadingOlder,
  onSelect,
  onLoadOlder,
}: {
  requests: RequestSummary[];
  selectedId: string | null;
  freshIds: ReadonlySet<string>;
  hasMore: boolean;
  loadingOlder: boolean;
  onSelect: (id: string) => void;
  onLoadOlder: () => void;
}) {
  return (
    <div>
      <ul className="divide-y divide-slate-200" aria-label="Captured requests">
        {requests.map((r) => {
          const selected = r.id === selectedId;
          const fresh = freshIds.has(r.id);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={selected ? 'true' : undefined}
                className={`block w-full px-3 py-2.5 text-left transition-colors ${
                  selected ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'
                } ${fresh && !selected ? 'bg-sky-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <MethodBadge method={r.method} />
                  <span className="truncate font-mono text-sm font-medium">
                    {shortRequestId(r.id)}
                  </span>
                  <span
                    className={`truncate text-sm ${selected ? 'text-sky-100' : 'text-slate-600'}`}
                  >
                    {r.client_ip ?? '—'}
                  </span>
                </div>
                <div
                  className={`mt-0.5 flex flex-wrap items-center gap-x-3 text-xs ${
                    selected ? 'text-sky-100' : 'text-slate-500'
                  }`}
                >
                  <time dateTime={r.received_at} title={fullDate(r.received_at)}>
                    {relativeTime(r.received_at)}
                  </time>
                  <span>{formatBytes(r.size_bytes)}</span>
                  {r.path !== '/' && <span className="truncate font-mono">{r.path}</span>}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div className="px-3 py-3 text-center">
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingOlder}
            className={btnSecondary}
          >
            {loadingOlder ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </div>
  );
}
