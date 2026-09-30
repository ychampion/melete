/**
 * Two surfaces. `/devices` is Settings: a signed-in owner lists, pairs,
 * changes and revokes computers. `/device` is the companion: it pairs with a
 * code, then authenticates every call with its token. The session middleware
 * leaves `/device` alone, and each route here checks the token itself.
 */
import {
  DEVICE_LIMITS,
  deviceHelloRequest,
  deviceHelloResponse,
  deviceListResponse,
  devicePairingRequest,
  devicePairingResponse,
  devicePairRequest,
  devicePairResponse,
  devicePollResponse,
  deviceResponse,
  deviceResult,
  deviceUpdateRequest,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RequestSource } from '../api/listener.ts';
import type { DeviceService } from './service.ts';

const tooLarge = (c: Context) =>
  c.json({ error: { code: 'payload_too_large', message: 'Request body is too large.' } }, 413);
const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
// A result carries at most a file, a command's capped output, or a screenshot in base64.
const resultBody = bodyLimit({
  maxSize: Math.ceil((DEVICE_LIMITS.max_screenshot_bytes * 4) / 3) + 64 * 1024,
  onError: tooLarge,
});

const unauthorized = (c: Context) =>
  c.json(
    {
      error: {
        code: 'unauthorized',
        message: 'This computer is not connected. Pair it again from Settings.',
      },
    },
    401,
  );

/**
 * Wrong codes are counted per address. A code has 31^8 values and lives ten
 * minutes, so this only keeps a guesser from wasting the service's time.
 */
class PairingThrottle {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60_000,
  ) {}
  retryAfter(address: string, now = Date.now()): number {
    const recent = (this.failures.get(address) ?? []).filter((at) => now - at < this.windowMs);
    this.failures.set(address, recent);
    if (recent.length < this.limit) return 0;
    return Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000);
  }
  fail(address: string, now = Date.now()) {
    this.failures.set(address, [...(this.failures.get(address) ?? []), now]);
  }
}

const clientAddress = (c: Context): string => {
  const source = c.env as RequestSource | undefined;
  return source?.clientAddress ?? source?.remoteAddress ?? 'unknown';
};

const browserAllowed = (device: {
  capabilities: { browser?: boolean };
  localCapabilities: { browser?: boolean };
}) => device.capabilities.browser === true && device.localCapabilities.browser === true;

export function mountDevices(app: Hono, devices: DeviceService) {
  const throttle = new PairingThrottle();

  /* ---------- Settings ---------- */
  const spaceOf = (c: Context) => {
    const spaceId = c.get('experienceSpaceId') as string | undefined;
    if (!spaceId) throw new Error('No session space');
    return spaceId;
  };

  app.get('/devices', async (c) =>
    c.json(
      deviceListResponse.parse({
        devices: await devices.list(spaceOf(c), c.get('owner').id),
      }),
    ),
  );
  app.post('/devices/pairings', async (c) => {
    const input = devicePairingRequest.parse(await c.req.json().catch(() => ({})));
    const pairing = await devices.createPairing(spaceOf(c), c.get('owner').id, input.capabilities);
    return c.json(devicePairingResponse.parse(pairing), 201);
  });
  app.patch('/devices/:id', async (c) => {
    const input = deviceUpdateRequest.parse(await c.req.json());
    const device = await devices.update(c.req.param('id'), c.get('owner').id, input.capabilities);
    return c.json(deviceResponse.parse({ device }));
  });
  app.post('/devices/:id/revoke', async (c) => {
    const device = await devices.revoke(c.req.param('id'), c.get('owner').id);
    return c.json(deviceResponse.parse({ device }));
  });

  /* ---------- the companion ---------- */
  app.post('/device/pair', smallBody, async (c) => {
    const address = clientAddress(c);
    const wait = throttle.retryAfter(address);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json(
        { error: { code: 'pairing_rate_limited', message: 'Too many wrong codes. Try later.' } },
        429,
      );
    }
    const input = devicePairRequest.parse(await c.req.json());
    const paired = await devices.pair(input);
    if (!paired) {
      throttle.fail(address);
      return c.json(
        {
          error: {
            code: 'invalid_code',
            message: 'That code is wrong, already used, or expired. Make a new one in Settings.',
          },
        },
        400,
      );
    }
    return c.json(devicePairResponse.parse(paired), 201);
  });

  app.post('/device/hello', smallBody, async (c) => {
    const device = await devices.authenticate(c.req.header('authorization'));
    if (!device) return unauthorized(c);
    const input = deviceHelloRequest.parse(await c.req.json());
    return c.json(deviceHelloResponse.parse(await devices.hello(device, input)));
  });

  app.get('/device/requests', async (c) => {
    const device = await devices.authenticate(c.req.header('authorization'));
    if (!device) return unauthorized(c);
    await devices.seen(device);
    // The browser bridge polls its own channel; everything else is the companion's.
    const channel = c.req.query('channel') === 'browser' ? 'browser' : 'main';
    if (channel === 'browser' && !browserAllowed(device))
      return c.json(
        {
          error: {
            code: 'capability_off',
            message: 'Using the browser is turned off for this computer.',
          },
        },
        403,
      );
    const requests = await devices.hub.poll(
      device.id,
      DEVICE_LIMITS.poll_wait_ms,
      c.req.raw.signal,
      channel,
    );
    return c.json(devicePollResponse.parse({ requests }));
  });

  // The browser extension was switched off or closed: nothing more is handed to it.
  app.post('/device/browser/leave', smallBody, async (c) => {
    const device = await devices.authenticate(c.req.header('authorization'));
    if (!device) return unauthorized(c);
    devices.hub.leave(device.id, 'browser');
    return c.json({ status: 'ok' as const });
  });

  app.post('/device/requests/:id/result', resultBody, async (c) => {
    const device = await devices.authenticate(c.req.header('authorization'));
    if (!device) return unauthorized(c);
    const result = deviceResult.parse(await c.req.json());
    if (!devices.hub.settle(device.id, c.req.param('id'), result))
      return c.json(
        { error: { code: 'not_found', message: 'Nothing by that id is waiting for an answer.' } },
        404,
      );
    return c.json({ status: 'ok' as const });
  });
}
