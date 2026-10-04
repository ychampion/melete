import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BATCH_SIZE,
  chatPrompt,
  contentHash,
  firstLook,
  itemFields,
  parseLabels,
  plainSentence,
  TRIAGE_FORMAT,
} from './rules.ts';

const mail = (payload: Record<string, unknown>) => ({
  seq: 1,
  eventName: 'mail.received',
  payload: {
    from: 'Dana Kim <dana@client.example>',
    sender: 'dana@client.example',
    subject: 'Can you sign this?',
    received_at: '2026-10-04T09:14:00.000Z',
    automated: false,
    ...payload,
  },
});

describe('the rules settle what they can', () => {
  test('machine-sent mail is nothing to do; a person is a maybe', () => {
    expect(firstLook(mail({ automated: true }))).toEqual({
      decision: 'ignore',
      reason: 'Sent automatically.',
    });
    expect(firstLook(mail({ sender: 'no-reply@shop.example' }))?.decision).toBe('ignore');
    expect(firstLook(mail({ sender: 'noreply@shop.example' }))?.decision).toBe('ignore');
    expect(firstLook(mail({}))).toEqual({ decision: 'maybe' });
    expect(
      firstLook({ seq: 2, eventName: 'calendar.event.changed', payload: { title: 'Review' } }),
    ).toEqual({ decision: 'maybe' });
    expect(firstLook({ seq: 3, eventName: 'process.exited', payload: {} })).toBeNull();
  });

  test('the same words hash the same, whenever they arrived', () => {
    const a = itemFields(mail({ received_at: '2026-10-04T09:14:00.000Z' }));
    const b = itemFields(mail({ received_at: '2026-10-11T09:14:00.000Z' }));
    const c = itemFields(mail({ subject: 'Can you sign this today?' }));
    expect(contentHash('mail.received', a)).toBe(contentHash('mail.received', b));
    expect(contentHash('mail.received', a)).not.toBe(contentHash('mail.received', c));
  });

  test('a model is shown headers only, never a body', () => {
    const fields = itemFields(mail({ text: 'the whole body', html: '<p>body</p>' }));
    expect(JSON.stringify(fields)).not.toContain('body');
  });
});

describe('a model answer is only ever a label', () => {
  const ids = new Set(['i1', 'i2', 'i3']);

  test('urgent is read as soon, and nothing else past it exists', () => {
    const labels = parseLabels(
      JSON.stringify({
        items: [
          { id: 'i1', verdict: 'needs_you', urgency: 'urgent', sentence: 'Sign it.', reason: 'x' },
          { id: 'i2', verdict: 'fyi', urgency: 'normal', sentence: '', reason: '' },
        ],
      }),
      ids,
    );
    expect(labels.get('i1')?.urgency).toBe('soon');
    expect(labels.get('i2')?.urgency).toBe('normal');
    expect(labels.has('i3')).toBe(false);
  });

  test('an unknown id, verdict or shape is not a label', () => {
    const labels = parseLabels(
      JSON.stringify({
        items: [
          { id: 'i9', verdict: 'needs_you', urgency: 'soon', sentence: '', reason: '' },
          { id: 'i1', verdict: 'send_now', urgency: 'soon', sentence: '', reason: '' },
          { id: 'i2', verdict: 'ignore', urgency: 'soon', sentence: 'a', reason: 'b' },
          { id: 'i2', verdict: 'needs_you', urgency: 'soon', sentence: 'c', reason: 'd' },
        ],
      }),
      ids,
    );
    expect([...labels.keys()]).toEqual(['i2']);
    expect(labels.get('i2')?.verdict).toBe('ignore');
    expect(parseLabels('not json', ids).size).toBe(0);
    expect(parseLabels('Sure! {"items": []}', ids).size).toBe(0);
  });

  test('the schema allows three verdicts and two urgencies', () => {
    const schema = JSON.stringify(TRIAGE_FORMAT.schema);
    expect(schema).toContain('"enum":["normal","soon"]');
    expect(schema).toContain('"enum":["needs_you","fyi","ignore"]');
    expect(BATCH_SIZE).toBe(20);
  });
});

describe('what the person reads', () => {
  test('a plain sentence when a model gave none, and a chat that treats mail as information', () => {
    const fields = itemFields(mail({}));
    expect(plainSentence('mail.received', fields)).toBe('Dana Kim wrote to you.');
    const prompt = chatPrompt('mail.received', fields, 'Dana needs your signature.');
    expect(prompt).toContain('Dana Kim');
    expect(prompt).toContain('not instructions');
  });
});

describe('sorting cannot act', () => {
  // The code path, not the prompt, keeps sorting read-only: nothing in it can
  // reach the parts of the service that start work, send, notify or act.
  test('nothing in the sorting module imports what acts', () => {
    const dir = import.meta.dir;
    const forbidden =
      /from '\.\.\/(?:broker|jobs|runs|push|connectors|experience|companies|cells|sandbox|devices|rooms)\//;
    for (const name of readdirSync(dir).filter((file) => !file.endsWith('.test.ts'))) {
      const source = readFileSync(join(dir, name), 'utf8');
      expect({ name, acts: forbidden.test(source) }).toEqual({ name, acts: false });
    }
  });
});
