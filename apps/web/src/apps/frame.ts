/**
 * What the app frame shows, and when a newly issued view replaces the one it
 * loaded. Reloading the frame loses whatever the person was doing in the app,
 * so it happens only when it must: the app now shows another version, or the
 * view the frame loaded with is about to end. A view lasts hours and is
 * checked on every file the frame loads, so most renewals change nothing on
 * screen; they are how the screen notices a lost grant or a new version.
 */

/** How often the screen asks again, to notice a new version or that the person lost the app. */
export const CHECK_EVERY_MS = 60_000;
/** A frame whose own view ends sooner than this is reloaded with the new one. */
export const RELOAD_BEFORE_MS = 10 * 60_000;

export type Frame =
  | { kind: 'loading' }
  | { kind: 'open'; src: string; versionId: string; srcExpiresAt: string }
  | { kind: 'ended'; reason: string };

export type IssuedView = { src: string; versionId: string; expiresAt: string };

/** The frame after a view was issued. `fresh` forces the frame to load it. */
export function nextFrame(current: Frame, view: IssuedView, now: number, fresh = false): Frame {
  const reload = {
    kind: 'open' as const,
    src: view.src,
    versionId: view.versionId,
    srcExpiresAt: view.expiresAt,
  };
  if (fresh || current.kind !== 'open' || current.versionId !== view.versionId) return reload;
  if (new Date(current.srcExpiresAt).getTime() - now < RELOAD_BEFORE_MS) return reload;
  return current;
}
