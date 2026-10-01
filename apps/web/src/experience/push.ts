/**
 * Phone presence in the browser. The service worker is registered on load so
 * the app can be installed, but a person is only asked about pushes after the
 * first moment Melete was worth hearing from: a decision made, or a chase
 * settled. Never on the first visit.
 */
import { adapter } from './adapter.ts';
import type { PushDevice } from './types.ts';

const MOMENT_KEY = 'melete.push.moment';
const DISMISSED_KEY = 'melete.push.dismissed';
export const MOMENT_EVENT = 'melete:value-moment';

const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage blocked: the offer simply is not remembered.
    }
  },
};

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Registers the service worker; a tapped push that finds this tab moves it to the decision. */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    // Not installable in this browser; everything else works the same.
  });
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type !== 'melete:open' || !data.url) return;
    const target = new URL(data.url, window.location.origin);
    if (target.origin === window.location.origin) window.location.hash = target.hash || '#/';
  });
}

/** The first moment worth a push: remembered, and announced to whatever offers it. */
export function markValueMoment(): void {
  if (storage.get(MOMENT_KEY)) return;
  storage.set(MOMENT_KEY, new Date().toISOString());
  window.dispatchEvent(new Event(MOMENT_EVENT));
}

export const valueMomentReached = () => storage.get(MOMENT_KEY) !== null;
export const offerDismissed = () => storage.get(DISMISSED_KEY) !== null;
export const dismissOffer = () => storage.set(DISMISSED_KEY, new Date().toISOString());

/** A name a person recognises in the device list. */
export function deviceLabel(userAgent: string = navigator.userAgent): string {
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'This device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;
  return browser ? `${device} · ${browser}` : device;
}

function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The endpoint's SHA-256, base64url: how the service names each device without its endpoint. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** This browser's own subscription, if it has one. */
async function browserSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** The hash of this browser's subscription endpoint, or null when it has none. */
export async function thisBrowserHash(): Promise<string | null> {
  const subscription = await browserSubscription();
  return subscription ? endpointHash(subscription.endpoint) : null;
}

/**
 * Pushes arrive here only when this browser holds a subscription and the
 * service still lists it: a row removed from another device, or dropped after
 * the push service said it was gone, no longer counts.
 */
export function subscribedHere(hash: string | null, devices: readonly PushDevice[]): boolean {
  return hash !== null && devices.some((device) => device.endpoint_hash === hash);
}

export type EnableResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'unsupported' | 'not_configured' | 'denied' | 'failed'; message: string };

/** Asks the browser, subscribes, and tells the service about this device. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported())
    return {
      ok: false,
      reason: 'unsupported',
      message:
        'This browser can’t receive pushes. On an iPhone, add Melete to your Home Screen first.',
    };
  const key = await adapter.pushPublicKey();
  if (!key.data?.public_key)
    return {
      ok: false,
      reason: 'not_configured',
      message: key.error ?? 'Pushes aren’t set up on this installation.',
    };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    return {
      ok: false,
      reason: 'denied',
      message: 'Notifications are blocked for Melete. Allow them in your browser settings.',
    };
  try {
    const registration = await navigator.serviceWorker.ready;
    let existing = await registration.pushManager.getSubscription();
    // One the service no longer lists may be one the push service gave up on: start afresh.
    if (existing) {
      const listed = await adapter.pushDevices();
      const hash = await endpointHash(existing.endpoint);
      if (!subscribedHere(hash, listed.data?.subscriptions ?? [])) {
        await existing.unsubscribe();
        existing = null;
      }
    }
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key.data.public_key) as BufferSource,
      }));
    const json = subscription.toJSON() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    const saved = await adapter.subscribePush({
      endpoint: json.endpoint,
      keys: json.keys,
      device_label: deviceLabel(),
    });
    if (saved.data === null)
      return { ok: false, reason: 'failed', message: saved.error ?? saved.unavailable };
    return { ok: true, id: saved.data.subscription.id };
  } catch {
    return {
      ok: false,
      reason: 'failed',
      message: 'This browser couldn’t subscribe. Try again in a moment.',
    };
  }
}

/**
 * Whether pushes reach this browser: it has a subscription and the service lists
 * it. When the list can't be read, the browser's own answer stands.
 */
export async function thisDeviceSubscribed(): Promise<boolean> {
  const hash = await thisBrowserHash();
  if (hash === null) return false;
  const listed = await adapter.pushDevices();
  return listed.data ? subscribedHere(hash, listed.data.subscriptions) : true;
}

/** Stops pushes here: the browser forgets the subscription as well as the service. */
export async function forgetThisBrowser(): Promise<void> {
  await (await browserSubscription())?.unsubscribe();
}
