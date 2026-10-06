import type { LiveStatus } from '../lib/useLiveRequests';

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-600',
  POST: 'bg-sky-600',
  PUT: 'bg-amber-600',
  PATCH: 'bg-violet-600',
  DELETE: 'bg-red-600',
  OPTIONS: 'bg-slate-500',
  HEAD: 'bg-slate-500',
};

export function MethodBadge({ method, large = false }: { method: string; large?: boolean }) {
  const color = METHOD_COLORS[method] ?? 'bg-slate-600';
  return (
    <span
      className={`inline-block shrink-0 rounded font-mono font-semibold uppercase text-white ${color} ${
        large ? 'px-2 py-0.5 text-sm' : 'px-1.5 py-0.5 text-[11px]'
      }`}
    >
      {method}
    </span>
  );
}

const LIVE_STYLES: Record<LiveStatus, { dot: string; label: string; title: string }> = {
  live: { dot: 'bg-emerald-500', label: 'Live', title: 'Connected: new requests appear instantly' },
  polling: {
    dot: 'bg-amber-500',
    label: 'Polling',
    title: 'Real-time connection unavailable; refreshing every 5 seconds',
  },
  offline: { dot: 'bg-red-500', label: 'Offline', title: 'The service is unreachable' },
};

export function LiveBadge({ status }: { status: LiveStatus }) {
  const s = LIVE_STYLES[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600"
      title={s.title}
      role="status"
    >
      <span
        className={`h-2 w-2 rounded-full ${s.dot} ${status === 'live' ? 'animate-pulse' : ''}`}
      />
      {s.label}
    </span>
  );
}
