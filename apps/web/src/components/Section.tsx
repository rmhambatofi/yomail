import { useState } from 'react';
import type { ReactNode } from 'react';

/** Collapsible block with the webhook.site-style "▾ Title" header. */
export function Section({
  title,
  children,
  defaultOpen = true,
  actions,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-slate-200 last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-sm font-semibold text-slate-800"
          aria-expanded={open}
        >
          <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          {title}
        </button>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}
