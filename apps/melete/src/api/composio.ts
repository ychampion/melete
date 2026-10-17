/**
 * Composio's routes: the search over apps a person can connect through it,
 * and the address its triggers deliver to.
 *
 * A delivery carries no session and is believed only for its signature
 * under `COMPOSIO_WEBHOOK_SECRET`; without the secret the route answers 404.
 * Every delivery is counted toward the trigger-event limit before anything
 * else, since Composio has already billed it.
 */
import { composioAppSearchResponse } from '@melete/contracts';
import type { Hono } from 'hono';
import { ComposioFault } from '../connectors/composio.ts';
import type { ComposioCatalog } from '../connectors/composio-catalog.ts';
import { type ComposioTriggers, signedByComposio } from '../connectors/composio-triggers.ts';
import { ServiceError } from './errors.ts';

export const COMPOSIO_EVENTS_PATH = '/composio/events';
/** The most a delivery may weigh; a trigger's payload is a notice, not the mail itself. */
const MAX_DELIVERY_BYTES = 256 * 1024;

export function mountComposio(
  app: Hono,
  deps: {
    catalog?: ComposioCatalog;
    triggers?: ComposioTriggers;
    webhookSecret?: string;
    now?: () => number;
  },
): void {
  app.get('/composio/apps', async (c) => {
    if (!deps.catalog)
      throw new ServiceError(
        'provider_not_configured',
        'Connecting apps through Composio needs a Composio key. Set COMPOSIO_API_KEY.',
        409,
      );
    try {
      const apps = await deps.catalog.search(c.req.query('query') ?? '');
      return c.json(composioAppSearchResponse.parse({ apps }));
    } catch (error) {
      if (error instanceof ComposioFault)
        throw new ServiceError('provider_unreachable', 'Composio did not answer. Try again.', 502);
      throw error;
    }
  });

  app.post(COMPOSIO_EVENTS_PATH, async (c) => {
    const secret = deps.webhookSecret;
    const triggers = deps.triggers;
    if (!secret || !triggers)
      return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    const body = await c.req.text();
    if (Buffer.byteLength(body) > MAX_DELIVERY_BYTES)
      return c.json({ error: { code: 'too_large', message: 'Too large.' } }, 413);
    const signed = signedByComposio(
      secret,
      {
        id: c.req.header('webhook-id') ?? null,
        timestamp: c.req.header('webhook-timestamp') ?? null,
        signature: c.req.header('webhook-signature') ?? null,
      },
      body,
      deps.now?.(),
    );
    if (!signed) return c.json({ error: { code: 'unauthorized', message: 'Bad signature.' } }, 401);
    let delivery: unknown;
    try {
      delivery = JSON.parse(body);
    } catch {
      delivery = null;
    }
    await triggers.receive(delivery);
    return c.body(null, 204);
  });
}
