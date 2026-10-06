const KEY = 'yomail.recentEndpoints';
const MAX = 10;

export interface RecentEndpoint {
  id: string;
  /** ISO 8601 of the last time the inbox was opened */
  openedAt: string;
}

/**
 * Per-browser list of endpoints the user opened, newest first. localStorage can be
 * unavailable (private mode, blocked storage), so every access is guarded and the
 * list is simply empty in that case. This is a convenience, never a source of truth.
 */
export function listRecentEndpoints(): RecentEndpoint[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEndpoint =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RecentEndpoint).id === 'string' &&
        typeof (e as RecentEndpoint).openedAt === 'string',
    );
  } catch {
    return [];
  }
}

export function rememberEndpoint(id: string): void {
  const rest = listRecentEndpoints().filter((e) => e.id !== id);
  save([{ id, openedAt: new Date().toISOString() }, ...rest].slice(0, MAX));
}

export function forgetEndpoint(id: string): void {
  save(listRecentEndpoints().filter((e) => e.id !== id));
}

function save(list: RecentEndpoint[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: nothing to remember */
  }
}
