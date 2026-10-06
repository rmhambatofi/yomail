import { useMemo } from 'react';

/**
 * Renders a server-sanitized HTML request body inside a sandboxed iframe.
 *  - sandbox WITHOUT allow-same-origin: the document gets an opaque origin, so it
 *    cannot touch our cookies/storage or the parent page. Never add allow-same-origin.
 *  - allow-popups + allow-popups-to-escape-sandbox: links (target=_blank, set by the
 *    sanitizer) open in a normal new tab.
 *  - A CSP meta blocks everything except inline styles and, after "Load images", images.
 *  - Remote images arrive as data-src; `loadImages` swaps them to src before injection.
 * Height is fixed and scrollable: measuring contentDocument would need allow-same-origin.
 */
export function HtmlFrame({ html, loadImages }: { html: string; loadImages: boolean }) {
  const srcDoc = useMemo(() => buildDocument(html, loadImages), [html, loadImages]);
  return (
    <iframe
      title="HTML preview"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="h-[70vh] w-full rounded-md border border-slate-200 bg-white"
    />
  );
}

const IMG_SRC = loadImagesCsp(true);
const NO_IMG_SRC = loadImagesCsp(false);

function loadImagesCsp(images: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    images ? 'img-src data: https: http:' : 'img-src data:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function buildDocument(html: string, loadImages: boolean): string {
  const body = loadImages ? html.replace(/\sdata-src="/g, ' src="') : html;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${loadImages ? IMG_SRC : NO_IMG_SRC}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
    'html,body{margin:0;padding:0}' +
    'body{padding:16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;word-wrap:break-word;overflow-wrap:anywhere}' +
    'img{max-width:100%;height:auto}' +
    'img[data-src]{display:inline-block;min-width:16px;min-height:16px;background:#f1f5f9;border:1px dashed #cbd5e1}' +
    'table{max-width:100%}' +
    'a{color:#1d4ed8} a:not([href]){color:inherit;text-decoration:none}' +
    'pre{white-space:pre-wrap}' +
    '</style></head><body>' +
    body +
    '</body></html>'
  );
}
