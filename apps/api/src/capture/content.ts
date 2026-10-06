import busboy from 'busboy';
import type { ContentKind, DroppedFile, Pair } from '@yomail/shared';

export interface ParsedContent {
  contentKind: ContentKind;
  /** Raw body text; null for none, multipart and binary */
  body: string | null;
  formFields: Pair[] | null;
  droppedFiles: DroppedFile[] | null;
}

/** Textual application/* types that are stored as `text` rather than `binary`. */
const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/graphql',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/x-httpd-php',
]);

/** Lower-cased media type without parameters, or null when the header is absent/empty. */
export function mediaTypeOf(contentType: string | null): string | null {
  if (!contentType) return null;
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type.length > 0 ? type : null;
}

/**
 * Classifies a request body from its Content-Type (see docs/PLAN.md §4):
 *   none | json | form | multipart | html | xml | text | binary.
 * `text/plain` and a missing Content-Type are sniffed: valid JSON becomes `json`,
 * bytes that do not look like text become `binary`.
 */
export function classifyContent(contentType: string | null, raw: Buffer): ContentKind {
  if (raw.length === 0) return 'none';
  const type = mediaTypeOf(contentType);

  if (type === null) return looksBinary(raw) ? 'binary' : sniffJson(raw) ? 'json' : 'text';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if (type === 'multipart/form-data') return 'multipart';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml';
  if (type === 'text/plain') return sniffJson(raw) ? 'json' : 'text';
  if (type.startsWith('text/') || TEXTUAL_APPLICATION_TYPES.has(type)) return 'text';
  return 'binary';
}

/** Parses the body according to its kind. Never throws: unparsable input degrades to `text`. */
export async function parseContent(
  contentType: string | null,
  raw: Buffer,
): Promise<ParsedContent> {
  const kind = classifyContent(contentType, raw);
  const empty: ParsedContent = {
    contentKind: kind,
    body: null,
    formFields: null,
    droppedFiles: null,
  };

  switch (kind) {
    case 'none':
    case 'binary':
      return empty;
    case 'json': {
      const text = raw.toString('utf8');
      if (!isValidJson(text)) return { ...empty, contentKind: 'text', body: text };
      return { ...empty, body: text };
    }
    case 'form': {
      const text = raw.toString('utf8');
      return { ...empty, body: text, formFields: parseUrlEncoded(text) };
    }
    case 'multipart': {
      try {
        const { fields, files } = await parseMultipart(contentType ?? '', raw);
        return { ...empty, formFields: fields, droppedFiles: files };
      } catch {
        // Bad boundary or truncated payload: keep the raw text so nothing is lost.
        return { ...empty, contentKind: 'text', body: raw.toString('utf8') };
      }
    }
    default:
      return { ...empty, body: raw.toString('utf8') };
  }
}

export function parseUrlEncoded(text: string): Pair[] {
  const pairs: Pair[] = [];
  for (const [name, value] of new URLSearchParams(text)) pairs.push([name, value]);
  return pairs;
}

function parseMultipart(
  contentType: string,
  raw: Buffer,
): Promise<{ fields: Pair[]; files: DroppedFile[] }> {
  return new Promise((resolve, reject) => {
    const fields: Pair[] = [];
    const files: DroppedFile[] = [];
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: { 'content-type': contentType },
        limits: { fields: 1000, files: 100 },
      });
    } catch (err) {
      reject(err as Error);
      return;
    }
    parser.on('field', (name, value) => fields.push([name, value]));
    parser.on('file', (name, stream, info) => {
      // Files are never stored: count the bytes, then drop them.
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });
      stream.on('end', () => files.push({ field: name, filename: info.filename ?? '', size }));
    });
    parser.on('error', (err) => reject(err as Error));
    parser.on('close', () => resolve({ fields, files }));
    parser.end(raw);
  });
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function sniffJson(raw: Buffer): boolean {
  const first = firstNonSpace(raw);
  if (first !== 0x7b && first !== 0x5b) return false; // '{' or '['
  return isValidJson(raw.toString('utf8'));
}

function firstNonSpace(raw: Buffer): number {
  for (let i = 0; i < raw.length && i < 64; i++) {
    const b = raw[i]!;
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return b;
  }
  return -1;
}

/** A NUL byte in the first KB is a good enough binary signal for untyped bodies. */
function looksBinary(raw: Buffer): boolean {
  const limit = Math.min(raw.length, 1024);
  for (let i = 0; i < limit; i++) if (raw[i] === 0) return true;
  return false;
}
