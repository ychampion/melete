import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import type { TwilioOptions } from '../connectors/twilio.ts';
import type { Database } from '../db/client.ts';
import type { ExperienceService } from '../experience/service.ts';
import { managesConnection, spaceAuthority } from '../principals/authority.ts';
import { SmsInbox } from './inbox.ts';

/** Twilio reads an empty TwiML document as "nothing to send back now". */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** The path of a webhook request, which the session check lets through unsigned-in. */
export const SMS_WEBHOOK_PATH = /^\/sms\/twilio\/[A-Za-z0-9_]{1,80}$/;

export type SmsRouteDeps = {
  db: Database;
  sql: Sql;
  secrets: SecretAccess;
  publicUrl?: string;
  twilio?: TwilioOptions;
  experience?: ExperienceService;
  seen?: (principalId: string) => Promise<unknown>;
};

/**
 * Twilio's webhook, which carries no session and is believed only for its
 * signature, and the owner's list of texts that reached the number.
 */
export function mountSms(app: Hono, deps: SmsRouteDeps): SmsInbox {
  const inbox = new SmsInbox(deps);

  app.post('/sms/twilio/:id', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded'))
      return c.text('Forbidden', 403);
    const params = new URLSearchParams(await c.req.text());
    const outcome = await inbox.receive(
      c.req.param('id'),
      params,
      c.req.header('X-Twilio-Signature'),
    );
    if (outcome === 'forbidden') return c.text('Forbidden', 403);
    return c.body(EMPTY_TWIML, 200, { 'content-type': 'text/xml; charset=utf-8' });
  });

  app.get('/connections/:id/texts', async (c) => {
    const id = c.req.param('id');
    const [row] =
      await deps.sql`select space_id, provider, shared_use from connection where id = ${id}`;
    if (row?.provider !== 'twilio')
      throw new ServiceError('not_found', 'Connection not found.', 404);
    const access = await spaceAuthority(deps.db, String(row.space_id), c.get('owner').id);
    // A number kept for a room's maker is theirs: the owners they added read
    // only the texts of a number that serves the room.
    if (!managesConnection(access, String(row.shared_use)))
      throw new ServiceError('scope_denied', 'Connection is not accessible.', 403);
    return c.json(await inbox.texts(id));
  });

  return inbox;
}
