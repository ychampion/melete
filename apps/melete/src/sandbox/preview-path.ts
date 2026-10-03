/**
 * Where a person's preview of a server in an agent's computer is served,
 * below the API's own address. The web server reads this file too, so it
 * imports nothing.
 */
export const PREVIEW_PREFIX = '/previews/';

/** A read through a preview: like an app's files, it carries a token and no session. */
export const previewPath = (method: string, path: string): boolean =>
  (method === 'GET' || method === 'HEAD') && path.startsWith(PREVIEW_PREFIX);
