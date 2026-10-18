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

describe("the person's own words in a message", () => {
  test('are kept exactly when the person typed them', () => {
    const body = 'Running late — ten minutes, sorry!';
    const payload = { to: '+15550100', body };
    const said = ['Text Sam exactly this:   Running late — ten minutes,\nsorry!'];
    expect(humanPayload('sms.send', payload, said)).toBe(payload);
  });

  test("keep their line while the model's lines around it lose their dashes", () => {
    const out = humanPayload(
      'email.draft',
      {
        subject: 'Keys — where they are',
        body: 'Hi Ana — a note from Sam.\n\nThe keys are under the mat — the blue one.\n\nSam',
      },
      ['Tell her: the keys are under the mat — the blue one.'],
    );
    expect(out.subject).toBe('Keys, where they are');
    expect(out.body).toBe(
      'Hi Ana, a note from Sam.\n\nThe keys are under the mat — the blue one.\n\nSam',
    );
  });

  test('a dash the person never typed is still the model’s', () => {
    // Words of theirs nearby are not enough: the dash itself must be in what they typed.
    const out = humanPayload('sms.send', { body: 'Running late — ten minutes.' }, [
      'Tell Sam I am running late, ten minutes or so.',
    ]);
    expect(out.body).toBe('Running late, ten minutes.');
  });
});
