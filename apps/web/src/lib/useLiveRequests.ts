import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, RequestSummary, ServerToClientEvents } from '@yomail/shared';
import { ApiError, api } from '../api/client';
import { API_URL } from '../config';

export const PAGE_SIZE = 50;
const POLL_MS = 5_000;
const HIGHLIGHT_MS = 2_500;

/** live: socket connected · polling: socket down, REST every 5 s · offline: REST failing too */
export type LiveStatus = 'live' | 'polling' | 'offline';
export type LoadStatus = 'loading' | 'ready' | 'not-found' | 'error';

export interface LiveRequestsState {
  status: LoadStatus;
  error: Error | null;
  live: LiveStatus;
  requests: RequestSummary[];
  hasMore: boolean;
  retentionDays: number | null;
  /** Ids that arrived live in the last seconds (for the list highlight) */
  freshIds: ReadonlySet<string>;
  loadingOlder: boolean;
  loadOlder: () => void;
  reload: () => void;
  /** Local updates after a successful REST call (the socket event may or may not follow). */
  removeLocal: (id: string) => void;
  clearLocal: () => void;
}

type LiveSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function byNewest(a: RequestSummary, b: RequestSummary): number {
  return b.received_at.localeCompare(a.received_at);
}

/** Merges a freshly fetched page into the current list: dedupe by id, newest first. */
function merge(current: RequestSummary[], incoming: RequestSummary[]): RequestSummary[] {
  const byId = new Map<string, RequestSummary>();
  for (const r of current) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort(byNewest);
}

/**
 * Keeps the request list of one endpoint up to date:
 *  - initial REST load, then Socket.IO `request:new` / `request:deleted` / `endpoint:*` events;
 *  - while the socket is down (Passenger without WebSocket, network blip, API asleep) the
 *    newest page is re-fetched every 5 s and merged, so the inbox still moves;
 *  - on (re)connect the list is reloaded to catch anything missed.
 * Events can arrive twice (in-memory path + DB change detector on the server), so every
 * insertion is deduped by id.
 */
export function useLiveRequests(endpointId: string | null): LiveRequestsState {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [live, setLive] = useState<LiveStatus>('polling');
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [tick, setTick] = useState(0);
  const socketRef = useRef<LiveSocket | null>(null);
  const requestsRef = useRef(requests);
  requestsRef.current = requests;

  const markFresh = useCallback((id: string) => {
    setFreshIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setFreshIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, HIGHLIGHT_MS);
  }, []);

  const fetchNewest = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      if (!endpointId) return false;
      try {
        const page = await api.requests(endpointId, { limit: PAGE_SIZE }, signal);
        setRetentionDays(page.retention_days);
        setRequests((prev) => {
          const merged = merge(prev, page.requests);
          // Highlight rows the poll discovered that were not displayed yet.
          const known = new Set(prev.map((r) => r.id));
          for (const r of page.requests) if (!known.has(r.id) && prev.length > 0) markFresh(r.id);
          return merged;
        });
        setHasMore((prev) => prev || page.has_more);
        setStatus('ready');
        setError(null);
        return true;
      } catch (err) {
        if (signal?.aborted) return false;
        if (err instanceof ApiError && err.status === 404) {
          setStatus('not-found');
        } else {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStatus((s) => (s === 'loading' ? 'error' : s));
        }
        return false;
      }
    },
    [endpointId, markFresh],
  );

  // Initial load (and explicit reloads).
  useEffect(() => {
    setStatus('loading');
    setRequests([]);
    setHasMore(false);
    if (!endpointId) {
      setStatus('not-found');
      return;
    }
    const ctrl = new AbortController();
    void fetchNewest(ctrl.signal);
    return () => ctrl.abort();
  }, [endpointId, fetchNewest, tick]);

  // Socket.IO subscription (kept across request selection; re-created only per endpoint).
  const notFound = status === 'not-found';
  useEffect(() => {
    if (!endpointId || notFound) return;
    const socket: LiveSocket = io({ path: `${API_URL}/socket.io`, reconnectionDelayMax: 5_000 });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('subscribe', { endpointId });
      setLive('live');
      // Every (re)connect reloads the newest page: it catches anything captured while
      // disconnected and recovers an inbox whose initial load failed (API asleep or down).
      // The polling loop stops as soon as the socket is live, so this is the only way back.
      void fetchNewest();
    });
    socket.on('disconnect', () => setLive((l) => (l === 'offline' ? l : 'polling')));
    socket.on('connect_error', () => setLive((l) => (l === 'offline' ? l : 'polling')));
    socket.on('request:new', (r) => {
      if (r.endpoint_id !== endpointId) return;
      setRequests((prev) => (prev.some((x) => x.id === r.id) ? prev : [r, ...prev].sort(byNewest)));
      markFresh(r.id);
    });
    socket.on('request:deleted', (p) => {
      if (p.endpointId === endpointId) setRequests((prev) => prev.filter((r) => r.id !== p.id));
    });
    socket.on('endpoint:cleared', (p) => {
      if (p.endpointId === endpointId) {
        setRequests([]);
        setHasMore(false);
      }
    });
    socket.on('endpoint:deleted', (p) => {
      if (p.endpointId === endpointId) setStatus('not-found');
    });

    return () => {
      socket.emit('unsubscribe', { endpointId });
      socket.close();
      socketRef.current = null;
    };
  }, [endpointId, notFound, fetchNewest, markFresh]);

  // REST polling whenever the socket is not live.
  useEffect(() => {
    if (!endpointId || live === 'live' || status === 'not-found' || status === 'loading') return;
    const timer = setInterval(() => {
      void fetchNewest().then((ok) => {
        setLive((l) => (l === 'live' ? l : ok ? 'polling' : 'offline'));
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [endpointId, live, status, fetchNewest]);

  const loadOlder = useCallback(() => {
    const last = requestsRef.current[requestsRef.current.length - 1];
    if (!endpointId || !last || loadingOlder) return;
    setLoadingOlder(true);
    api
      .requests(endpointId, { limit: PAGE_SIZE, before: last.received_at })
      .then((page) => {
        setRequests((prev) => merge(prev, page.requests));
        setHasMore(page.has_more);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setLoadingOlder(false));
  }, [endpointId, loadingOlder]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const removeLocal = useCallback(
    (id: string) => setRequests((prev) => prev.filter((r) => r.id !== id)),
    [],
  );
  const clearLocal = useCallback(() => {
    setRequests([]);
    setHasMore(false);
  }, []);

  return {
    status,
    error,
    live,
    requests,
    hasMore,
    retentionDays,
    freshIds,
    loadingOlder,
    loadOlder,
    reload,
    removeLocal,
    clearLocal,
  };
}
