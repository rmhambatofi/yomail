import type { Pair } from '@yomail/shared';
import { isProxyHeader } from '../lib/headers';
import { CopyButton } from './CopyButton';

export function HeadersTable({ headers }: { headers: Pair[] }) {
  if (headers.length === 0) return <p className="text-sm text-slate-500">No headers.</p>;
  const asText = headers.map(([n, v]) => `${n}: ${v}`).join('\n');
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <CopyButton value={asText} label="Copy all" />
      </div>
      <table className="w-full table-fixed text-xs">
        <tbody>
          {headers.map(([name, value], i) => {
            // Proxy headers are dimmed so the caller's own stand out.
            const proxy = isProxyHeader(name);
            return (
              <tr key={i} className={`border-t border-slate-100 ${proxy ? 'text-slate-400' : ''}`}>
                <th
                  scope="row"
                  className="w-2/5 py-1 pr-2 text-left align-top font-medium text-slate-700 break-all"
                  style={proxy ? { color: 'inherit' } : undefined}
                >
                  {name.toLowerCase()}
                </th>
                <td className="py-1 align-top font-mono break-all">{value}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PairsTable({ pairs, emptyLabel }: { pairs: Pair[]; emptyLabel: string }) {
  if (pairs.length === 0) return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  return (
    <table className="w-full table-fixed text-xs">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="w-2/5 py-1 pr-2 font-medium">Name</th>
          <th className="py-1 font-medium">Value</th>
        </tr>
      </thead>
      <tbody>
        {pairs.map(([name, value], i) => (
          <tr key={i} className="border-t border-slate-100">
            <td className="py-1 pr-2 align-top font-medium text-slate-700 break-all">{name}</td>
            <td className="py-1 align-top font-mono break-all whitespace-pre-wrap">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
