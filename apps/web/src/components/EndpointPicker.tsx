import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { extractEndpointId, shortEndpointId } from '@yomail/shared';
import { listRecentEndpoints } from '../lib/recentEndpoints';
import { btnSecondary } from './Feedback';

/**
 * Switch to another endpoint from the inbox: paste an id or a full endpoint URL, or pick
 * one of the recently opened endpoints (native datalist, no custom dropdown).
 */
export function EndpointPicker({ currentId }: { currentId: string | null }) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recents = listRecentEndpoints().filter((e) => e.id !== currentId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = extractEndpointId(value);
    if (!id) {
      setError('Paste an endpoint id or URL');
      return;
    }
    setError(null);
    setValue('');
    navigate(`/inbox/${id}`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <input
          type="text"
          list="recent-endpoints"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="Open another endpoint (id or URL)…"
          aria-label="Open another endpoint"
          className="w-full min-w-0 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs text-slate-800 focus:border-sky-500 focus:outline-none sm:w-80"
          spellCheck={false}
        />
        <datalist id="recent-endpoints">
          {recents.map((r) => (
            <option key={r.id} value={r.id}>
              {shortEndpointId(r.id)} · opened {new Date(r.openedAt).toLocaleDateString()}
            </option>
          ))}
        </datalist>
        <button type="submit" className={btnSecondary}>
          Open
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
