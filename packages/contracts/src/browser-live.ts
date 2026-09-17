/**
 * The live browser channel while a person has taken control: frames and notices go down,
 * typed input goes up. Input names page-level events only, never a browser protocol method.
 */
import { z } from 'zod';

export const LIVE_VIEWPORT = { width: 1024, height: 768 } as const;

const KB = 1024;
const MB = 1024 * KB;
export const LIVE_LIMITS = {
  input_events_per_second: 200,
  input_bytes_per_second: 64 * KB,
  input_event_bytes: 4 * KB,
  text_bytes: 4 * KB,
  text_events_per_second: 4,
  events_per_batch: 200,
  frames_per_second: 10,
  frame_bytes_per_second: 500 * KB,
  frame_budget_window_ms: 10_000,
  unacked_frames: 2,
  site_scope_hosts: 12,
  redirect_hops: 20,
  popups_per_takeover: 8,
  takeover_ms: 20 * 60_000,
  pull_timeout_ms: 10_000,
  requests_per_takeover: 2000,
  network_bytes_per_takeover: 32 * MB,
} as const;

export const liveNoticeCode = z.enum([
  'off_scope',
  'redirect_refused',
  'download_refused',
  'upload_refused',
  'websocket_refused',
  'popup_limit',
  'live_budget',
]);
export type LiveNoticeCode = z.infer<typeof liveNoticeCode>;

export const liveEndCode = z.enum([
  'closed',
  'epoch_changed',
  'session_not_found',
  'slow_down',
  'live_timeout',
  'live_budget',
]);
export type LiveEndCode = z.infer<typeof liveEndCode>;

export const liveId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const liveOpen = z.strictObject({
  live_id: liveId,
  control_epoch: z.number().int().nonnegative(),
  viewport: z.strictObject({
    width: z.literal(LIVE_VIEWPORT.width),
    height: z.literal(LIVE_VIEWPORT.height),
  }),
  site_scope: z.array(z.string()).max(128),
  expires_at: z.string(),
});
export type LiveOpen = z.infer<typeof liveOpen>;

export const liveFrame = z.strictObject({
  type: z.literal('frame'),
  seq: z.number().int().positive(),
  /** Base64 JPEG. Frames are relayed and painted, never stored. */
  data: z.string(),
  meta: z.strictObject({
    device_width: z.number(),
    device_height: z.number(),
    page_scale: z.number(),
    offset_top: z.number(),
    scroll_x: z.number(),
    scroll_y: z.number(),
  }),
});
export const liveWhere = z.strictObject({
  type: z.literal('where'),
  url: z.string(),
  title: z.string(),
  in_scope: z.boolean(),
});
export const liveNotice = z.strictObject({
  type: z.literal('notice'),
  code: liveNoticeCode,
  host: z.string().optional(),
});
export const liveEnded = z.strictObject({ type: z.literal('ended'), code: liveEndCode });
export const liveDown = z.discriminatedUnion('type', [liveFrame, liveWhere, liveNotice, liveEnded]);
export type LiveFrame = z.infer<typeof liveFrame>;
export type LiveWhere = z.infer<typeof liveWhere>;
export type LiveNotice = z.infer<typeof liveNotice>;
export type LiveEnded = z.infer<typeof liveEnded>;
export type LiveDown = z.infer<typeof liveDown>;

const x = z.number().min(0).max(LIVE_VIEWPORT.width);
const y = z.number().min(0).max(LIVE_VIEWPORT.height);
/** Alt 1, Control 2, Meta 4, Shift 8. */
const mods = z.number().int().min(0).max(15);
const delta = z.number().min(-10_000).max(10_000);

export const liveInput = z.discriminatedUnion('k', [
  z.strictObject({
    k: z.enum(['move', 'down', 'up']),
    x,
    y,
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    mods,
    clicks: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.strictObject({ k: z.literal('wheel'), x, y, dx: delta, dy: delta, mods }),
  z.strictObject({
    k: z.literal('key'),
    down: z.boolean(),
    key: z.string().min(1).max(64),
    code: z.string().max(64),
    vk: z.number().int().min(0).max(255),
    mods,
    text: z.string().min(1).max(16).optional(),
  }),
  /** Typing and paste into the focused page control. */
  z.strictObject({ k: z.literal('text'), text: z.string().min(1).max(LIVE_LIMITS.text_bytes) }),
  z.strictObject({
    k: z.literal('touch'),
    phase: z.enum(['start', 'move', 'end']),
    /** The points still touching after this event; empty when the last finger lifts. */
    points: z.array(z.strictObject({ id: z.number().int().min(0).max(16), x, y })).max(10),
  }),
]);
export type LiveInput = z.infer<typeof liveInput>;

export const liveUp = z.strictObject({
  live_id: liveId,
  ack_through: z.number().int().nonnegative(),
  events: z.array(liveInput).max(LIVE_LIMITS.events_per_batch),
});
export type LiveUp = z.infer<typeof liveUp>;
