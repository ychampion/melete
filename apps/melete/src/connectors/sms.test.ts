import { describe, expect, test } from 'bun:test';
import { mailAction, mailContext } from './mail-fixtures.ts';
import type { SecretAccess } from './secrets.ts';
import { SMS_MORE_IN_APP, SmsConnector, smsParts } from './sms.ts';
import type { TwilioFetch } from './twilio.ts';

const credentials = {
  account_sid: `AC${'b'.repeat(32)}`,
  auth_token: 'c'.repeat(32),
  from_number: '+15550001111',
};
const secrets: SecretAccess = {
  withSecret: (_id, _space, use) => use(JSON.stringify(credentials)),
};

function connector(fetch: TwilioFetch) {
  return new SmsConnector(
    { id: 'con_test', spaceId: 'spc_test', secretRef: 'sec_test', twilio: { fetch } },
    secrets,
  );
}

const created = (body: string, extra: Record<string, unknown> = {}) =>
  Response.json(
    {
      sid: `SM${'2'.repeat(32)}`,
      to: '+15552223333',
      from: credentials.from_number,
      body,
      status: 'queued',
      date_created: new Date().toUTCString(),
      error_code: null,
      ...extra,
    },
    { status: 201 },
  );

describe('sms.send', () => {
  test('sends the approved number and text exactly, once, and keeps the Twilio sid', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const sms = connector(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return created('See you at six.');
    });
    const action = mailAction('sms.send', { to: '+15552223333', body: 'See you at six.' });
    const result = await sms.execute(action, mailContext());
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') throw new Error('not sent');
    expect(result.receipt.external_ref).toBe(`SM${'2'.repeat(32)}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toEndWith(`/Accounts/${credentials.account_sid}/Messages.json`);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      To: '+15552223333',
      From: credentials.from_number,
      Body: 'See you at six.',
    });
  });

  test('a send whose answer is lost is unknown, never failed, so it is not sent again', async () => {
    const sms = connector(async () => {
      throw new Error('connection reset');
    });
    const result = await sms.execute(
      mailAction('sms.send', { to: '+15552223333', body: 'Hello' }),
      mailContext(),
    );
    expect(result.outcome).toBe('unknown');
    const flaky = connector(async () => new Response('bad gateway', { status: 502 }));
    expect(
      (
        await flaky.execute(
          mailAction('sms.send', { to: '+15552223333', body: 'Hello' }),
          mailContext(),
        )
      ).outcome,
    ).toBe('unknown');
  });

  test('a refusal from Twilio is a plain failure: nothing was sent', async () => {
    const sms = connector(async () => Response.json({ code: 21211 }, { status: 400 }));
    const result = await sms.execute(
      mailAction('sms.send', { to: '+15552223333', body: 'Hello' }),
      mailContext(),
    );
    expect(result).toMatchObject({ outcome: 'failed', retryable: false });
  });

  test('refuses a payload that is not one number and one text, before asking Twilio', async () => {
    let called = false;
    const sms = connector(async () => {
      called = true;
      return created('x');
    });
    for (const payload of [
      { to: '5552223333', body: 'no country code' },
      { to: ['+15552223333', '+15554445555'], body: 'two recipients' },
      { to: '+15552223333', body: 'x'.repeat(1601) },
      { to: '+15552223333', body: 'Hello', media: 'https://example.test/a.png' },
      { to: credentials.from_number, body: 'to itself' },
    ]) {
      const result = await sms.execute(mailAction('sms.send', payload), mailContext());
      expect(result.outcome).toBe('failed');
    }
    expect(called).toBe(false);
  });

  test('refuses an action that belongs to another connection or space', async () => {
    const sms = connector(async () => created('Hello'));
    const action = mailAction('sms.send', { to: '+15552223333', body: 'Hello' });
    expect(
      (await sms.execute({ ...action, connection_id: 'con_other' }, mailContext())).outcome,
    ).toBe('failed');
    expect((await sms.execute(action, { ...mailContext(), space_id: 'spc_other' })).outcome).toBe(
      'failed',
    );
  });

  test('verify finds the sent text at Twilio by number, text and time', async () => {
    const action = mailAction('sms.send', { to: '+15552223333', body: 'On my way' });
    const listed: string[] = [];
    const list = (messages: unknown[]) =>
      connector(async (url) => {
        listed.push(url);
        return Response.json({ messages });
      });
    const sent = list([
      {
        sid: `SM${'3'.repeat(32)}`,
        to: '+15552223333',
        from: credentials.from_number,
        body: 'On my way',
        status: 'delivered',
        date_created: new Date(Date.parse(action.dispatched_at ?? '')).toUTCString(),
      },
    ]);
    const found = await sent.verify(action, mailContext());
    expect(found).toMatchObject({ decision: 'succeeded' });
    const query = new URL(listed[0] ?? '').searchParams;
    expect(query.get('To')).toBe('+15552223333');
    expect(query.get('From')).toBe(credentials.from_number);
    // Another text, or the same text from long before, is not this one.
    const other = list([
      {
        sid: `SM${'4'.repeat(32)}`,
        body: 'Something else',
        status: 'delivered',
        date_created: new Date().toUTCString(),
      },
      {
        sid: `SM${'5'.repeat(32)}`,
        body: 'On my way',
        status: 'delivered',
        date_created: 'Mon, 01 Jan 2024 00:00:00 +0000',
      },
    ]);
    expect((await other.verify(action, mailContext())).decision).toBe('undecided');
  });

  test('health says when Twilio refuses the credential', async () => {
    const refused = connector(async () => new Response('', { status: 401 }));
    expect(await refused.health()).toMatchObject({
      status: 'failing',
      reason: 'credential_refused',
    });
    const fine = connector(async () => Response.json({ sid: credentials.account_sid }));
    expect((await fine.health()).status).toBe('ok');
  });
});

describe('splitting a reply into texts', () => {
  const septets = (text: string) => text.length;

  test('a short reply is one text, unchanged', () => {
    expect(smsParts('  Lunch is at noon.  ')).toEqual(['Lunch is at noon.']);
    expect(smsParts('')).toEqual([]);
  });

  test('a long reply is cut where a reader pauses, each text within ten segments', () => {
    const paragraph = `${'The meeting moved to Thursday. '.repeat(30).trim()}`;
    const reply = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const parts = smsParts(reply);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(septets(part)).toBeLessThanOrEqual(1530);
      // Every cut lands after a sentence, never inside a word.
      expect(part.endsWith('.') || part.endsWith(SMS_MORE_IN_APP)).toBe(true);
    }
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(reply.replace(/\s+/g, ' '));
  });

  test('text outside the GSM alphabet gets the smaller budget', () => {
    const reply = 'Café ☕ opens at nine. '.repeat(60).trim();
    const parts = smsParts(reply);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(670);
    expect(parts.length).toBeGreaterThan(1);
  });

  test('never more than three texts; the last says the rest is in the app', () => {
    const reply = 'word '.repeat(5000).trim();
    const parts = smsParts(reply);
    expect(parts).toHaveLength(3);
    expect(parts[2]?.endsWith(SMS_MORE_IN_APP)).toBe(true);
    expect(parts[2]?.length).toBeLessThanOrEqual(1530);
  });

  test('a character outside the basic plane is never cut in half', () => {
    const reply = '😀'.repeat(1000);
    for (const part of smsParts(reply, 10))
      expect(part.replace(SMS_MORE_IN_APP, '').replace(/😀|\n/gu, '')).toBe('');
  });
});
