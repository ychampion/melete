import { reachConsentRequest, reachNumberRequest, reachVerifyRequest } from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { ReachService } from './service.ts';
import { xml } from './twilio.ts';

/** The provider's webhooks, which carry no session and are believed only for their signature. */
export const REACH_WEBHOOK_PATH =
  /^\/reach\/twilio\/(sms|status\/rch_[0-9A-Z]{26}|key\/rch_[0-9A-Z]{26})$/;

const twiml = (c: Context, inner = '') =>
  c.body(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, 200, {
    'content-type': 'text/xml; charset=utf-8',
  });

/** The signed-in person's own number and agreement, and the provider's webhooks. */
export function mountReach(app: Hono, service: ReachService) {
  const person = (c: Context) => {
    const owner = c.get('owner');
    if (owner.kind === 'guest')
      throw new ServiceError('scope_denied', 'Only people with an account set this.', 403);
    return owner.id as string;
  };
  app.get('/reach', async (c) => c.json({ reach: await service.state(person(c)) }));
  app.post('/reach/number', async (c) => {
    const input = reachNumberRequest.parse(await c.req.json());
    return c.json({ reach: await service.requestCode(person(c), input.number) });
  });
  app.delete('/reach/number', async (c) => c.json({ reach: await service.forget(person(c)) }));
  app.post('/reach/number/verify', async (c) => {
    const input = reachVerifyRequest.parse(await c.req.json());
    return c.json({ reach: await service.verify(person(c), input.code) });
  });
  app.post('/reach/consent', async (c) => {
    const input = reachConsentRequest.parse(await c.req.json());
    return c.json({ reach: await service.agree(person(c), input) });
  });
  app.delete('/reach/consent', async (c) => c.json({ reach: await service.withdraw(person(c)) }));

  // The address the provider signed: the public one, as the provider called it.
  const signed = async (c: Context) => {
    const type = c.req.header('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
    const base = service.deps.config.callbackBase;
    if (!base) return null;
    return {
      url: `${base}${c.req.path}`,
      params: new URLSearchParams(await c.req.text()),
      signature: c.req.header('X-Twilio-Signature'),
    };
  };
  app.post('/reach/twilio/sms', async (c) => {
    const request = await signed(c);
    if (!request) return c.text('Forbidden', 403);
    const answer = await service.inbound(request.url, request.params, request.signature);
    if (answer.outcome === 'forbidden') return c.text('Forbidden', 403);
    // The provider answers its own keywords (STOP, START, HELP); an opt-out in
    // other words gets Melete's one confirmation.
    return twiml(c, answer.reply ? `<Message>${xml(answer.reply)}</Message>` : '');
  });
  app.post('/reach/twilio/status/:id', async (c) => {
    const request = await signed(c);
    if (!request) return c.text('Forbidden', 403);
    const ok = await service.receipt(
      c.req.param('id'),
      request.url,
      request.params,
      request.signature,
    );
    return ok ? c.body(null, 204) : c.text('Forbidden', 403);
  });
  app.post('/reach/twilio/key/:id', async (c) => {
    const request = await signed(c);
    if (!request) return c.text('Forbidden', 403);
    const said = await service.keypress(
      c.req.param('id'),
      request.url,
      request.params,
      request.signature,
    );
    if (said === null) return c.text('Forbidden', 403);
    return twiml(c, `<Say>${xml(said)}</Say>`);
  });
}
