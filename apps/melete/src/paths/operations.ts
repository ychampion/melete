/**
 * Which action an effect is, beyond the service it reaches.
 *
 * The stop after an unconfirmed effect holds back the same action only: the
 * same form sent to the same address, the same request to an app, or anything
 * done for the same intent. And a connected app is preferred over the browser
 * only for an action it has a tool for. Both are read from the effect's
 * structure (where a form goes, the names of its fields, the name of an app's
 * tool), never from words on a page.
 */

/** What kind of action a form or a tool performs, when its structure says so. */
export type ActionClass = 'message' | 'event' | 'booking';

/** A form's address as one spelling: method, lower-case host, path without query or trailing slash. */
export function formTarget(url: string, method: string): string | null {
  try {
    const at = new URL(url);
    if (at.protocol !== 'https:' && at.protocol !== 'http:') return null;
    const host = at.hostname.replace(/\.$/, '').toLowerCase();
    const port = at.port ? `:${at.port}` : '';
    const path = at.pathname.replace(/\/+$/, '') || '/';
    return `form ${method.toUpperCase()} ${at.protocol}//${host}${port}${path}`;
  } catch {
    return null;
  }
}

const words = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const has = (names: ReadonlyArray<readonly string[]>, wanted: ReadonlySet<string>) =>
  names.some((parts) => parts.some((part) => wanted.has(part)));

const RECIPIENT = new Set(['to', 'recipient', 'recipients', 'cc', 'bcc']);
const CONTENT = new Set(['subject', 'body', 'message', 'text', 'content']);
const WHEN = new Set(['start', 'end', 'dtstart', 'dtend', 'date', 'starts', 'ends']);
const WHAT = new Set(['title', 'summary', 'subject', 'event']);
const PARTY = new Set(['party', 'covers', 'guests', 'seats', 'people', 'reservation', 'booking']);

/** The kind of action a form performs, from the names of its fields; null when they do not say. */
export function formClass(fields: Readonly<Record<string, unknown>>): ActionClass | null {
  const names = Object.keys(fields).map(words);
  if (has(names, RECIPIENT) && has(names, CONTENT)) return 'message';
  if (has(names, PARTY)) return 'booking';
  if (has(names, WHEN) && has(names, WHAT)) return 'event';
  return null;
}

/** The kind of action an app's tool performs, from its name; null when it does not say. */
export function toolClass(name: string): ActionClass | null {
  const parts = new Set(words(name));
  if (['send', 'reply', 'forward', 'message', 'post'].some((part) => parts.has(part)))
    return 'message';
  if (['book', 'booking', 'reserve', 'reservation'].some((part) => parts.has(part)))
    return 'booking';
  if (
    (parts.has('calendar') || parts.has('event')) &&
    ['create', 'update', 'add', 'insert', 'move'].some((part) => parts.has(part))
  )
    return 'event';
  return null;
}
