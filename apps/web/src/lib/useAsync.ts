import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Re-runs the loader; keeps current data visible while reloading. */
  reload: () => void;
}

/**
 * Minimal fetch-on-mount hook with abort on unmount / re-run.
 * `loader` must be stable (wrap it in useCallback) or the effect re-fires.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setLoading(true);
    loader(ctrl.signal)
      .then((result) => {
        if (ctrl.signal.aborted) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [loader, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
