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
/**
 * The most a delivery may weigh. A new-mail trigger carries the message's
 * text and parts, so it is larger than most webhooks; one past this is
 * refused unread, and its account is still read on its schedule. Applied
 * before the body is read (api/auth.ts) and again here.
 */
export const MAX_DELIVERY_BYTES = 1024 * 1024;

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
    // The signature covers the bytes as sent, so they are checked before any decoding.
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.byteLength > MAX_DELIVERY_BYTES)
      return c.json({ error: { code: 'too_large', message: 'Too large.' } }, 413);
    const id = c.req.header('webhook-id') ?? null;
    const signed = signedByComposio(
      secret,
      {
        id,
        timestamp: c.req.header('webhook-timestamp') ?? null,
        signature: c.req.header('webhook-signature') ?? null,
      },
      body,
      deps.now?.(),
    );
    if (!signed || !id)
      return c.json({ error: { code: 'unauthorized', message: 'Bad signature.' } }, 401);
    // Composio sends a delivery again until it is answered, and a signed one
    // could be sent again by anyone who saw it: each id is taken once.
    if (!(await triggers.firstDelivery(id))) return c.body(null, 204);
    let delivery: unknown;
    try {
      delivery = JSON.parse(body.toString('utf8'));
    } catch {
      delivery = null;
    }
    try {
      await triggers.receive(delivery);
    } catch (error) {
      // Not taken after all: Composio's next try is counted and acted on.
      await triggers.forgetDelivery(id).catch(() => undefined);
      throw error;
    }
    return c.body(null, 204);
  });
}
