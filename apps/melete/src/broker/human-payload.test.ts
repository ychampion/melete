import { describe, expect, test } from 'bun:test';
import { humanPayload } from './human-payload.ts';

describe('the words of an outgoing message', () => {
  test('lose their dashes in an email subject and body', () => {
    const payload = {
      to: ['sam@example.com'],
      subject: 'The lease — two questions',
      body: 'Hi Sam,\n\nThe heating is out again — could someone look this week?\n\nThanks,\nAlex',
    };
    const out = humanPayload('email.draft', payload);
    expect(out.subject).not.toContain('—');
    expect(out.body).not.toContain('—');
    expect(out.to).toBe(payload.to);
    // A greeting and a sign-off are the writer's choice in a message.
    expect(out.body).toStartWith('Hi Sam,');
    expect(out.body).toEndWith('Thanks,\nAlex');
  });

  test('lose their dashes in a text message', () => {
    const out = humanPayload('sms.send', { to: '+15550100', body: 'Running late — ten minutes.' });
    expect(out.body).not.toContain('—');
    expect(out.to).toBe('+15550100');
  });

  test('are left alone when nothing needs a change, or the tool is not a message', () => {
    const clean = { subject: 'Thursday', body: 'See you then.' };
    expect(humanPayload('email.send', clean)).toBe(clean);
    const other = { query: 'a — b' };
    expect(humanPayload('web.search', other)).toBe(other);
  });
});
