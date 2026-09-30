import { describe, expect, test } from 'bun:test';
import { TwilioClient, TwilioFailure, twilioSignature, validTwilioSignature } from './twilio.ts';

const credentials = {
  account_sid: `AC${'a'.repeat(32)}`,
  auth_token: 'f'.repeat(32),
  from_number: '+15550001111',
};

describe('the X-Twilio-Signature check', () => {
  // The worked example in https://www.twilio.com/docs/usage/security.
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  const params: [string, string][] = [
    ['CallSid', 'CA1234567890ABCDE'],
    ['Caller', '+14158675310'],
    ['Digits', '1234'],
    ['From', '+14158675310'],
    ['To', '+18005551212'],
  ];

  test("matches Twilio's documented example", () => {
    expect(twilioSignature(url, params, '12345')).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');
    // Order of arrival does not matter: the parameters are sorted by name.
    expect(twilioSignature(url, [...params].reverse(), '12345')).toBe(
      'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    );
  });

  test('a valid signature passes and anything changed is refused', () => {
    const signature = twilioSignature(url, params, '12345');
    expect(validTwilioSignature(signature, url, params, '12345')).toBe(true);
    // A tampered body.
    const tampered = params.map(([name, value]): [string, string] =>
      name === 'Digits' ? [name, '9999'] : [name, value],
    );
    expect(validTwilioSignature(signature, url, tampered, '12345')).toBe(false);
    // An added parameter.
    expect(validTwilioSignature(signature, url, [...params, ['Body', 'hi']], '12345')).toBe(false);
    // The wrong address: another path, another host, or the query left off.
    expect(
      validTwilioSignature(signature, 'https://example.com/other.php?foo=1&bar=2', params, '12345'),
    ).toBe(false);
    expect(
      validTwilioSignature(
        signature,
        'https://evil.example/myapp.php?foo=1&bar=2',
        params,
        '12345',
      ),
    ).toBe(false);
    expect(validTwilioSignature(signature, 'https://example.com/myapp.php', params, '12345')).toBe(
      false,
    );
    // The wrong token, no signature, or a signature of the wrong length.
    expect(validTwilioSignature(signature, url, params, '54321')).toBe(false);
    expect(validTwilioSignature(undefined, url, params, '12345')).toBe(false);
    expect(validTwilioSignature('short', url, params, '12345')).toBe(false);
  });

  test('names sort case-sensitively, as Unix sort does', () => {
    const mixed: [string, string][] = [
      ['b', '1'],
      ['B', '2'],
      ['a', '3'],
    ];
    // Upper case sorts before lower case: B, a, b.
    const expected = twilioSignature(
      'https://x.test/',
      [
        ['B', '2'],
        ['a', '3'],
        ['b', '1'],
      ],
      't',
    );
    expect(twilioSignature('https://x.test/', mixed, 't')).toBe(expected);
  });
});

describe('the Twilio REST client', () => {
  test('sends one message as a form POST with Basic authentication', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = new TwilioClient(credentials, {
      fetch: async (url, init) => {
        seen.push({ url, init });
        return Response.json(
          {
            sid: `SM${'1'.repeat(32)}`,
            to: '+15552223333',
            from: credentials.from_number,
            body: 'Hello there',
            status: 'queued',
            date_created: 'Wed, 30 Sep 2026 10:00:00 +0000',
            error_code: null,
          },
          { status: 201 },
        );
      },
    });
    const sent = await client.send('+15552223333', 'Hello there');
    expect(sent).toMatchObject({ sid: `SM${'1'.repeat(32)}`, status: 'queued' });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${credentials.account_sid}/Messages.json`,
    );
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${credentials.account_sid}:${credentials.auth_token}`).toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(String(call?.init.body));
    expect(Object.fromEntries(form)).toEqual({
      To: '+15552223333',
      From: credentials.from_number,
      Body: 'Hello there',
    });
  });

  test('says what a refusal means, and never what the server wrote', async () => {
    const answering = (status: number) =>
      new TwilioClient(credentials, {
        fetch: async () => Response.json({ message: 'secret detail' }, { status }),
      });
    for (const [status, code] of [
      [401, 'credential_refused'],
      [404, 'not_found'],
      [400, 'refused'],
      [429, 'rate_limited'],
      [503, 'unavailable'],
    ] as const) {
      const error = await answering(status)
        .account()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TwilioFailure);
      expect((error as TwilioFailure).code).toBe(code);
      expect(String((error as Error).message)).not.toContain('secret detail');
    }
    const offline = new TwilioClient(credentials, {
      fetch: async () => {
        throw new Error('network down');
      },
    });
    expect(
      ((await offline.account().catch((caught: unknown) => caught)) as TwilioFailure).code,
    ).toBe('unavailable');
  });
});
