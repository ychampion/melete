/**
 * Phone presence: Web Push subscriptions per person and device, and when
 * Melete may speak. Quiet hours are the profile's day hours read the other
 * way round, so there is one place a person says when their day is.
 */
import { z } from 'zod';
import { prefixedId, timestamp } from './common.ts';

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** This installation's VAPID public key, or null when push is not configured. */
export const pushPublicKeyResponse = z.strictObject({ public_key: z.string().nullable() });

/** What a browser's `PushSubscription.toJSON()` carries, plus a name for the device. */
export const pushSubscriptionRequest = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.strictObject({
    p256dh: z.string().min(80).max(120),
    auth: z.string().min(16).max(32),
  }),
  device_label: z.string().max(80).default(''),
});
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequest>;

/** A subscription as its owner sees it: never the endpoint or the keys. */
export const pushSubscriptionView = z.strictObject({
  id: prefixedId('psub'),
  device_label: z.string(),
  created_at: timestamp,
  last_used_at: timestamp.nullable(),
});
export const pushSubscriptionResponse = z.strictObject({ subscription: pushSubscriptionView });
export const pushSubscriptionList = z.strictObject({
  subscriptions: z.array(pushSubscriptionView),
});

export const pushSettings = z.strictObject({
  /** "One decision is waiting." */
  decisions: z.boolean(),
  /** "A chase settled." */
  settled: z.boolean(),
  /** The weekly "what came back" summary. */
  weekly_summary: z.boolean(),
  /** At most this many pushes a day; what is held back goes into the next one. */
  daily_cap: z.number().int().min(1).max(20),
  /** Events this close together go out as one push. */
  batch_minutes: z.number().int().min(0).max(240),
  /** Read from the profile: nothing is sent between `from` and `until`, in `time_zone`. */
  quiet_hours: z.strictObject({ from: clock, until: clock, time_zone: z.string() }),
});
export type PushSettings = z.infer<typeof pushSettings>;
export const pushSettingsUpdate = pushSettings.omit({ quiet_hours: true }).partial().strict();
export const pushSettingsResponse = z.strictObject({ settings: pushSettings });

/** What the service worker receives: every proactive message says why it was sent. */
export const pushPayload = z.strictObject({
  title: z.string().min(1).max(120),
  body: z.string().max(400),
  because: z.string().min(1).max(200),
  /** Where tapping it goes, inside the web app. */
  url: z.string().startsWith('/'),
  tag: z.string().max(64),
});
export type PushPayload = z.infer<typeof pushPayload>;
