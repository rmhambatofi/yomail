import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function Layout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? 'max-w-7xl' : 'max-w-4xl';
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className={`mx-auto flex ${width} items-center justify-between px-4 py-3`}>
          <Link to="/" className="text-lg font-bold tracking-tight text-slate-900">
            yomail
          </Link>
          <span className="text-xs text-slate-500">webhook catcher</span>
        </div>
      </header>
      <main className={`mx-auto w-full ${width} flex-1 px-4 py-6`}>{children}</main>
      <footer className="px-4 py-4 text-center text-xs text-slate-400">
        Anyone who knows an endpoint id can read its requests. Do not send anything private.
      </footer>
    </div>
  );
}
