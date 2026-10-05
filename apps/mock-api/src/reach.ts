/**
 * Texts and calls to the person's own number, in the mock. Nothing is sent:
 * the code is always 123456. `MELETE_MOCK_REACH=off` shows an installation
 * with no telephony provider, where Melete reaches people by push only.
 */
import {
  reachConsentRequest,
  reachNumberRequest,
  reachStateResponse,
  reachVerifyRequest,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { agreedWording, consentWording } from '../../melete/src/reach/policy.ts';

const fail = (code: string, message: string) => ({ error: { code, message } });
const FROM = '+14155550199';

export function mountReachMock(app: Hono, available: boolean): void {
  const kept = {
    number: null as string | null,
    verified_at: null as string | null,
    pending_number: null as string | null,
    pending_expires_at: null as string | null,
    consent: null as null | {
      number: string;
      texts: boolean;
      calls: boolean;
      nights: boolean;
      wording: string;
      agreed_at: string;
    },
  };
  const view = () =>
    reachStateResponse.parse({
      reach: {
        available,
        unavailable_reason: available
          ? null
          : 'Texts and calls aren’t set up on this installation, so Melete reaches you by push only.',
        from_number: available ? FROM : null,
        ...kept,
        opted_out_at: null,
        wording: consentWording(kept.number ?? 'your number'),
        today: { texts: 0, calls: 0, text_cap: 6, call_cap: 3 },
        recent: [],
      },
    });

  app.get('/reach', (c) => c.json(view()));
  app.post('/reach/number', async (c) => {
    if (!available) return c.json(fail('reach_not_configured', 'Texts aren’t set up here.'), 503);
    const parsed = reachNumberRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(fail('invalid_request', 'Write the number with + and the country code.'), 400);
    kept.pending_number = parsed.data.number;
    kept.pending_expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
    return c.json(view());
  });
  app.post('/reach/number/verify', async (c) => {
    const parsed = reachVerifyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.code !== '123456' || !kept.pending_number)
      return c.json(fail('reach_code_wrong', 'That code isn’t right.'), 400);
    if (kept.number !== kept.pending_number) kept.consent = null;
    kept.number = kept.pending_number;
    kept.verified_at = new Date().toISOString();
    kept.pending_number = null;
    kept.pending_expires_at = null;
    return c.json(view());
  });
  app.delete('/reach/number', (c) => {
    kept.number = null;
    kept.verified_at = null;
    kept.consent = null;
    return c.json(view());
  });
  app.post('/reach/consent', async (c) => {
    const parsed = reachConsentRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail('invalid_request', 'That doesn’t fit.'), 400);
    if (!kept.number) return c.json(fail('reach_not_verified', 'Verify your number first.'), 409);
    kept.consent = {
      number: kept.number,
      texts: true,
      ...parsed.data,
      wording: agreedWording(kept.number, parsed.data),
      agreed_at: new Date().toISOString(),
    };
    return c.json(view());
  });
  app.delete('/reach/consent', (c) => {
    kept.consent = null;
    return c.json(view());
  });
}
