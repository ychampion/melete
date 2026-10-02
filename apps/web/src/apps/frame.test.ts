/**
 * A renewed view reaches the frame when the frame's own view is about to end,
 * so an app open all day keeps loading its pages and files, and the frame is
 * not reloaded at every renewal.
 */
import { expect, test } from 'bun:test';
import { type Frame, nextFrame, RELOAD_BEFORE_MS } from './frame.ts';

const HOUR = 60 * 60_000;
const start = Date.parse('2026-10-02T08:00:00Z');
const issued = (at: number, version = 'v1') => ({
  src: `/api/apps/view/token-${at}/index.html`,
  versionId: version,
  expiresAt: new Date(at + 12 * HOUR).toISOString(),
});

test('a renewal reaches the frame before the view the frame loaded with ends', () => {
  let frame: Frame = nextFrame({ kind: 'loading' }, issued(start), start);
  const first = frame.kind === 'open' ? frame.src : '';
  // An hour in, nothing on screen changes.
  frame = nextFrame(frame, issued(start + HOUR), start + HOUR);
  expect(frame.kind === 'open' && frame.src).toBe(first);
  // Near the end of the first view, the frame takes the newest one.
  const late = start + 12 * HOUR - RELOAD_BEFORE_MS + 1;
  frame = nextFrame(frame, issued(late), late);
  expect(frame.kind === 'open' && frame.src).toBe(issued(late).src);
  expect(frame.kind === 'open' && frame.srcExpiresAt).toBe(issued(late).expiresAt);
});

test('a new version, or a fresh open, reloads the frame at once', () => {
  const frame = nextFrame({ kind: 'loading' }, issued(start), start);
  expect(nextFrame(frame, issued(start + 1, 'v2'), start + 1)).toMatchObject({ versionId: 'v2' });
  expect(nextFrame(frame, issued(start + 2), start + 2, true)).toMatchObject({
    src: issued(start + 2).src,
  });
});
