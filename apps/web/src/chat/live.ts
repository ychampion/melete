/**
 * Turning what a person does over the live view into page input: a point on
 * the drawn picture becomes a point in the agent's browser window, and a key
 * becomes the key event the page would have seen. Nothing here names a
 * browser protocol method; the service accepts page events only.
 */
import type { LiveInput } from '../experience/types.ts';

/** The agent's browser window, in page pixels. */
export const LIVE_VIEWPORT = { width: 1024, height: 768 } as const;

type Box = { left: number; top: number; width: number; height: number };
type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Alt 1, Control 2, Meta 4, Shift 8. */
export function modsOf(event: Modifiers): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** A point on the drawn picture, as a point in the page, kept inside the window. */
export function pagePoint(box: Box, clientX: number, clientY: number): { x: number; y: number } {
  const scale = (value: number, size: number, full: number) =>
    size > 0 ? Math.min(full, Math.max(0, Math.round((value / size) * full * 10) / 10)) : 0;
  return {
    x: scale(clientX - box.left, box.width, LIVE_VIEWPORT.width),
    y: scale(clientY - box.top, box.height, LIVE_VIEWPORT.height),
  };
}

export function pointerButton(button: number): 0 | 1 | 2 {
  return button === 1 ? 1 : button === 2 ? 2 : 0;
}

/**
 * A key as the page sees it. A printable character typed without Control or
 * Meta carries its text, so it types; everything else is a bare key press.
 */
export function keyInput(
  event: Modifiers & { key: string; code: string; keyCode: number },
  down: boolean,
): LiveInput | null {
  if (!event.key || event.key.length > 64 || event.key === 'Unidentified') return null;
  const mods = modsOf(event);
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  const text = event.key === 'Enter' ? '\r' : printable ? event.key : undefined;
  return {
    k: 'key',
    down,
    key: event.key,
    code: event.code.slice(0, 64),
    vk: Math.max(0, Math.min(255, event.keyCode || 0)),
    mods,
    ...(down && text ? { text } : {}),
  };
}

/** A pasted text, cut to what one input event may carry. */
export function pasteInput(text: string): LiveInput | null {
  const clipped = [...text].slice(0, 4000).join('');
  return clipped ? { k: 'text', text: clipped } : null;
}

/** The address as shown above the page: host and path, without the scheme. */
export function shownAddress(url: string | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

/** Two presses of Escape this close together leave the live view for the controls around it. */
export const ESCAPE_TWICE_MS = 600;
