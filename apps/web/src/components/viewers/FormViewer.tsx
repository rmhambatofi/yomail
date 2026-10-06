import type { DroppedFile, Pair } from '@yomail/shared';
import { formatBytes } from '../../lib/format';
import { PairsTable } from '../HeadersTable';

export function FormViewer({
  fields,
  droppedFiles,
}: {
  fields: Pair[];
  droppedFiles: DroppedFile[];
}) {
  return (
    <div className="space-y-3">
      <PairsTable pairs={fields} emptyLabel="No form fields." />
      {droppedFiles.length > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {droppedFiles.length} file part{droppedFiles.length === 1 ? '' : 's'} dropped (files are
          not stored):{' '}
          {droppedFiles.map((f, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <span className="font-mono">{f.filename || f.field}</span> {formatBytes(f.size)}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
