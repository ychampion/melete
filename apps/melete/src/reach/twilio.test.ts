import { describe, expect, test } from 'bun:test';
import { ReachSendFailure, TwilioReach } from './provider.ts';
import { TwilioClient, twilioSignature, validTwilioSignature, xml } from './twilio.ts';

const credentials = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'f'.repeat(32),
  fromNumber: '+15550001111',
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
    expect(twilioSignature(url, [...params].reverse(), '12345')).toBe(
      'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    );
  });

  test('a valid signature passes and anything changed is refused', () => {
    const signature = twilioSignature(url, params, '12345');
    expect(validTwilioSignature(signature, url, params, '12345')).toBe(true);
    const tampered = params.map(([name, value]): [string, string] =>
      name === 'Digits' ? [name, '9999'] : [name, value],
    );
    expect(validTwilioSignature(signature, url, tampered, '12345')).toBe(false);
    expect(validTwilioSignature(signature, url, [...params, ['Body', 'hi']], '12345')).toBe(false);
    expect(validTwilioSignature(signature, 'https://evil.example/myapp.php', params, '12345')).toBe(
      false,
    );
    expect(validTwilioSignature(signature, url, params, '54321')).toBe(false);
    expect(validTwilioSignature(undefined, url, params, '12345')).toBe(false);
    expect(validTwilioSignature('short', url, params, '12345')).toBe(false);
  });
});

describe('texts and calls through Twilio', () => {
  const answering =
    (status: number, body: unknown, seen: Array<{ url: string; form: URLSearchParams }> = []) =>
    async (input: string, init: RequestInit) => {
      seen.push({ url: input, form: new URLSearchParams(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    };

  test('a text and a call go from the installation’s number, with their receipt address', async () => {
    const seen: Array<{ url: string; form: URLSearchParams }> = [];
    const client = new TwilioClient(credentials, {
      fetch: answering(201, { sid: 'SM1', status: 'queued' }, seen),
    });
    expect(await client.text('+15557654321', 'hello', 'https://m.example/api/r')).toEqual({
      sid: 'SM1',
      status: 'queued',
    });
    await client.call('+15557654321', '<Response/>', null);
    expect(seen[0]?.url).toEndWith(`/Accounts/${credentials.accountSid}/Messages.json`);
    expect(seen[0]?.form.get('From')).toBe('+15550001111');
    expect(seen[0]?.form.get('StatusCallback')).toBe('https://m.example/api/r');
    expect(seen[1]?.url).toEndWith('/Calls.json');
    expect(seen[1]?.form.get('From')).toBe('+15550001111');
    expect(seen[1]?.form.get('Twiml')).toBe('<Response/>');
    expect(seen[1]?.form.has('StatusCallback')).toBe(false);
  });

  test('a STOP on Twilio’s side, a refusal and a lost answer are told apart', async () => {
    const outcome = async (status: number | 'network') => {
      const reach = new TwilioReach(credentials, {
        fetch:
          status === 'network'
            ? async () => {
                throw new Error('reset');
              }
            : answering(status, { code: status === 400 ? 21610 : 20003 }),
      });
      try {
        await reach.text('+15557654321', 'hi', null);
        return 'sent';
      } catch (error) {
        return error instanceof ReachSendFailure ? error.kind : 'other';
      }
    };
    expect(await outcome(400)).toBe('opted_out');
    expect(await outcome(401)).toBe('refused');
    expect(await outcome(503)).toBe('unknown');
    expect(await outcome('network')).toBe('unknown');
  });

  test('words spoken in a call are escaped', () => {
    expect(xml('A & B <c> "d"')).toBe('A &amp; B &lt;c&gt; &quot;d&quot;');
  });
});
