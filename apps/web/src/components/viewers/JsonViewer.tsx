import { useMemo } from 'react';
import type { ReactNode } from 'react';

type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'ws';

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)/g;

const CLASS: Record<TokenKind, string> = {
  key: 'text-sky-700',
  string: 'text-emerald-700',
  number: 'text-amber-700',
  literal: 'text-violet-700',
  punct: 'text-slate-500',
  ws: '',
};

/**
 * Pretty-prints JSON and colors tokens with React spans. The text is tokenized, never
 * injected as HTML, so untrusted bodies cannot escape into the page.
 */
export function JsonViewer({ text }: { text: string }) {
  const nodes = useMemo(() => tokenize(pretty(text)), [text]);
  return (
    <pre className="overflow-auto rounded-md bg-slate-900 p-4 font-mono text-xs leading-5 text-slate-100">
      {nodes}
    </pre>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function tokenize(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const [full, str, colon, num, lit, punct, ws] = m;
    let kind: TokenKind = 'ws';
    let value = full;
    if (str !== undefined) {
      kind = colon ? 'key' : 'string';
      value = str;
      if (colon) {
        out.push(
          <span key={key++} className={CLASS.key}>
            {str}
          </span>,
          colon,
        );
        last = index + full.length;
        continue;
      }
    } else if (num !== undefined) kind = 'number';
    else if (lit !== undefined) kind = 'literal';
    else if (punct !== undefined) kind = 'punct';
    else if (ws !== undefined) kind = 'ws';
    out.push(
      kind === 'ws' ? (
        value
      ) : (
        <span key={key++} className={CLASS[kind]}>
          {value}
        </span>
      ),
    );
    last = index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
