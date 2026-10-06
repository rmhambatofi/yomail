import sanitizeHtml from 'sanitize-html';

/**
 * Server-side sanitization of untrusted HTML request bodies (computed on read, never stored).
 *  - Formatting / table / image tags only; script, iframe, object, form, style blocks are dropped.
 *  - All on* handlers are dropped by the attribute whitelist.
 *  - Inline `style` attributes are kept unless they contain url(), expression() or @import.
 *  - Remote <img src="http(s)://..."> becomes data-src so the client only loads on "Load images".
 *    other schemes are removed.
 *  - Links open in a new tab with noopener/noreferrer/nofollow; only http(s)/mailto schemes survive.
 * The output is still rendered only inside a sandboxed iframe on the client.
 */
const DANGEROUS_STYLE = /url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:/i;

const options: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'abbr',
    'address',
    'b',
    'bdi',
    'bdo',
    'big',
    'blockquote',
    'br',
    'caption',
    'center',
    'cite',
    'code',
    'col',
    'colgroup',
    'dd',
    'del',
    'details',
    'dfn',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'font',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strike',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'time',
    'tr',
    'tt',
    'u',
    'ul',
    'var',
    'wbr',
  ],
  allowedAttributes: {
    '*': [
      'style',
      'class',
      'id',
      'dir',
      'lang',
      'title',
      'align',
      'valign',
      'width',
      'height',
      'bgcolor',
      'color',
      'border',
      'cellpadding',
      'cellspacing',
      'colspan',
      'rowspan',
    ],
    a: ['href', 'name', 'target', 'rel'],
    img: ['data-src', 'alt', 'width', 'height', 'align', 'border'],
    font: ['face', 'size', 'color'],
    td: ['nowrap'],
    th: ['nowrap', 'scope'],
    time: ['datetime'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'data-src'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // script/style/textarea/option content is dropped with the tag
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template', 'head', 'title'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...stripDangerousStyle(attribs),
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
    img: (tagName, attribs) => {
      const { src, ...rest } = stripDangerousStyle(attribs);
      const out: Record<string, string> = { ...rest };
      if (src && /^https?:\/\//i.test(src.trim())) {
        out['data-src'] = src.trim();
      }
      return { tagName, attribs: out };
    },
    '*': (tagName, attribs) => ({ tagName, attribs: stripDangerousStyle(attribs) }),
  },
};

function stripDangerousStyle(attribs: Record<string, string>): Record<string, string> {
  if (attribs.style && DANGEROUS_STYLE.test(attribs.style)) {
    const { style: _style, ...rest } = attribs;
    return rest;
  }
  return attribs;
}

export function sanitizeHtmlBody(html: string): string {
  return sanitizeHtml(html, options);
}
