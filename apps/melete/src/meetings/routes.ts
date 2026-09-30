/**
 * The Recall.ai webhook: `POST /webhooks/meetings/{connectionId}`.
 *
 * It is the one route here that answers a caller with no session, so it does
 * as little as possible with what it is told. The signature is checked against
 * the verification secret sealed in that connection, before the body is
 * parsed. A verified event only moves the named notetaker's next check to now;
 * the notes themselves are always fetched from Recall.ai by the worker, with
 * the connection's own key. An unknown notetaker, an unknown connection and a
 * bad signature all get the same refusal, and nothing in the body is echoed.
 */
import { ID_PREFIXES, meetingsCredentials, prefixedId } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { SecretAccess } from '../connectors/secrets.ts';
import { verifyRecallSignature } from './webhook.ts';

export const MEETING_WEBHOOK_PATH = /^\/webhooks\/meetings\/conn_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const refused = { error: { code: 'unauthorized', message: 'The webhook could not be verified.' } };

export function mountMeetingWebhook(
  app: Hono,
  deps: { sql: Sql; secrets: SecretAccess; now?: () => number },
) {
  app.post('/webhooks/meetings/:connectionId', async (c) => {
    const connectionId = prefixedId(ID_PREFIXES.connection).safeParse(c.req.param('connectionId'));
    if (!connectionId.success) return c.json(refused, 401);
    const body = await c.req.text();
    const [row] = await deps.sql`select space_id, secret_ref from connection
      where id = ${connectionId.data} and provider = 'meetings' and status <> 'revoked'`;
    if (!row?.secret_ref) return c.json(refused, 401);
    const verified = await deps.secrets
      .withSecret(String(row.secret_ref), String(row.space_id), async (sealed) => {
        const secret = meetingsCredentials.safeParse(JSON.parse(sealed)).data?.webhook_secret;
        return secret
          ? verifyRecallSignature(
              secret,
              {
                id: c.req.header('webhook-id'),
                timestamp: c.req.header('webhook-timestamp'),
                signature: c.req.header('webhook-signature'),
              },
              body,
              deps.now ? Math.floor(deps.now() / 1000) : undefined,
            )
          : false;
      })
      .catch(() => false);
    if (!verified) return c.json(refused, 401);
    let botId: unknown;
    try {
      botId = (JSON.parse(body) as { data?: { bot?: { id?: unknown } } })?.data?.bot?.id;
    } catch {
      return c.body(null, 204);
    }
    if (typeof botId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(botId))
      await deps.sql`update meeting_bot set next_check_at = now()
        where connection_id = ${connectionId.data} and bot_id = ${botId} and status = 'scheduled'`;
    return c.body(null, 204);
  });
}
