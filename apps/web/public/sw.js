/*
 * Melete's service worker. It shows a push with its reason, and a tap opens
 * what the push was about: in an open Melete window if there is one. A tap on
 * a push about something Melete noticed also tells Melete it was seen.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Melete';
  // Every push says why it was sent; the reason is the line under the words.
  const body = [data.body, data.because].filter(Boolean).join('\n');
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || 'melete',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/', ack: typeof data.ack === 'string' ? data.ack : null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  // Opening a push about something Melete noticed says the person saw it, so
  // nothing more is sent about it.
  const ack = event.notification.data?.ack;
  event.waitUntil(
    (async () => {
      if (typeof ack === 'string' && ack.startsWith('/'))
        // The service answers beside the app, under /api, as the app's own requests do.
        await fetch(new URL(`/api${ack}`, self.location.origin).href, {
          method: 'POST',
          credentials: 'same-origin',
        }).catch(() => {});
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        open.postMessage({ type: 'melete:open', url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
