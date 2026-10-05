/**
 * The operator switch for everything several people share: rooms, shared
 * spaces, their members, invites and guests, hand-offs, and chat platform
 * accounts linked to rooms (`MELETE_PREVIEW_MULTIPLAYER`, off by default).
 *
 * Off, those routes answer 404 `not_available` before anything is read or
 * written, the room tools are not offered, new spaces are not given them, and
 * a guest's sign-in is refused. Nothing stored is changed or removed: turning
 * the switch on again brings it all back as it was.
 */
import type { Hono } from 'hono';

export const MULTIPLAYER_UNAVAILABLE = {
  code: 'not_available',
  message: 'Rooms and shared spaces are not available on this server.',
} as const;

/** Whether the switch is on, read from parsed settings or from raw environment strings. */
export function multiplayerEnabled(
  env: { MELETE_PREVIEW_MULTIPLAYER?: boolean | string } | undefined,
): boolean {
  const value = env?.MELETE_PREVIEW_MULTIPLAYER;
  return value === true || value === 'true';
}

/** The routes that belong to the switch. Reads of a room are answered the same as writes. */
export function multiplayerPath(method: string, path: string): boolean {
  if (path === '/rooms' || path.startsWith('/rooms/')) return true;
  if (path === '/handoffs' || path.startsWith('/handoffs/')) return true;
  if (path === '/invites/view' || path === '/invites/accept') return true;
  if (path === '/me/linked-accounts' || path.startsWith('/me/linked-accounts/')) return true;
  if (method === 'POST' && path === '/spaces/shared') return true;
  // Adding someone to a shared space; taking someone out stays open.
  if (method === 'POST' && /^\/spaces\/[^/]+\/memberships$/.test(path)) return true;
  return false;
}

/** Answers the switch's routes with 404 while it is off. Mounted before every route it covers. */
export function mountMultiplayerGate(app: Hono, enabled: boolean): void {
  if (enabled) return;
  app.use('*', async (c, next) => {
    if (multiplayerPath(c.req.method, c.req.path))
      return c.json({ error: MULTIPLAYER_UNAVAILABLE }, 404);
    return next();
  });
}
