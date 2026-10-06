import { useState } from 'react';
import { btnSecondary } from '../Feedback';
import { HtmlFrame } from '../HtmlFrame';

/** Sandboxed preview of the server-sanitized HTML; remote images stay blocked until asked. */
export function HtmlViewer({ htmlSanitized }: { htmlSanitized: string }) {
  const [loadImages, setLoadImages] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span>Scripts are stripped and remote images blocked. Links open in a new tab.</span>
        {!loadImages && (
          <button type="button" onClick={() => setLoadImages(true)} className={btnSecondary}>
            Load images
          </button>
        )}
      </div>
      <HtmlFrame html={htmlSanitized} loadImages={loadImages} />
    </div>
  );
}
