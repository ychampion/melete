/**
 * How a stored file reaches the person: which ones the app shows in place,
 * and as what type. A PDF, a picture or text is shown; text always as plain
 * text. A web page, an SVG or anything else that can run script is never
 * shown in place, only downloaded.
 */

/** Types by extension, for a file recorded without one. Anything unknown is bytes. */
const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
};

export const mimeForName = (name: string): string =>
  BY_EXTENSION[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ??
  'application/octet-stream';

const SHOWN_IN_PLACE: Record<string, string> = {
  'application/pdf': 'application/pdf',
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'text/plain': 'text/plain; charset=utf-8',
  'text/markdown': 'text/plain; charset=utf-8',
  'text/csv': 'text/plain; charset=utf-8',
  'application/json': 'text/plain; charset=utf-8',
};

export const essence = (mime: string): string => mime.split(';')[0]?.trim().toLowerCase() ?? '';

/** The files tools that leave one file behind, at a place their receipt names. */
export const FILE_TOOLS = ['files.write', 'files.move', 'files.save_attachment'] as const;

/** Where a files action left its file, and the content it recorded, from its receipt. */
export function savedFile(
  kind: string,
  receipt: unknown,
): { area: 'work' | 'artifacts'; path: string; contentHash: string } | null {
  const detail = (receipt as { detail?: Record<string, unknown> } | null)?.detail ?? {};
  const path = kind === 'files.move' ? detail.to : detail.path;
  const area =
    kind === 'files.save_attachment'
      ? 'work'
      : kind === 'files.move'
        ? (detail.to_area ?? detail.area)
        : detail.area;
  if (
    !(FILE_TOOLS as readonly string[]).includes(kind) ||
    typeof path !== 'string' ||
    (area !== 'work' && area !== 'artifacts') ||
    typeof detail.content_hash !== 'string'
  )
    return null;
  return { area, path, contentHash: detail.content_hash };
}

/** The type a file is shown in place as, or null when it is only ever downloaded. */
export const shownInPlace = (mime: string): string | null => SHOWN_IN_PLACE[essence(mime)] ?? null;

/** A file name a header can carry: plain ASCII in `filename`, the exact name in `filename*`. */
function dispositionName(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\;]/g, '_') || 'file';
  const exact = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${plain}"; filename*=UTF-8''${exact}`;
}

/**
 * The headers a stored file is sent with. A download is an attachment. Shown
 * in place (`inline`, asked for with `?disposition=inline`), only a type
 * `shownInPlace` allows is, and a picture or text also gets an opaque origin
 * with nothing it may load. Audio plays in place, as before. Any other type,
 * a web page or an SVG among them, is sent as plain bytes with an opaque
 * origin, so no change to the disposition and no client that ignores it can
 * run its script here. Every response says `nosniff`, so the browser never
 * reads one type as another.
 */
export function fileHeaders(mime: string, name: string, inline: boolean): Headers {
  const shown = inline ? shownInPlace(mime) : null;
  const audio = essence(mime).startsWith('audio/');
  const known = audio || shownInPlace(mime) !== null;
  const headers = new Headers({
    'content-type': shown ?? (known ? mime : 'application/octet-stream'),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': `${shown || audio ? 'inline' : 'attachment'}; ${dispositionName(name)}`,
  });
  if (shown && shown !== 'application/pdf')
    headers.set(
      'content-security-policy',
      "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    );
  else if (!shown && !audio) headers.set('content-security-policy', "sandbox; default-src 'none'");
  return headers;
}
