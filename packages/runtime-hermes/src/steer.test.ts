import { describe, expect, test } from 'bun:test';
import { steerContinuation, steerInput } from './steer.ts';

describe('words sent while a run works', () => {
  test('carry the quote of the earlier message they reply to', () => {
    const input = steerInput([
      {
        id: 'steer_1',
        text: 'Only the first one.',
        quote: { message_id: '42', by: 'assistant', text: '1. TAP 2. easyJet' },
      },
    ]);
    expect(input).toContain('> [Replying to something you said earlier:]\n> > 1. TAP 2. easyJet');
    expect(input).toContain('> Only the first one.');
    expect(
      steerContinuation(
        [{ id: 's', text: 'x', quote: { message_id: '1', by: 'person', text: 'y' } }],
        '',
      ),
    ).toContain('an earlier message of theirs');
  });

  test('add nothing when they reply to nothing', () => {
    expect(steerInput([{ id: 'steer_2', text: 'Wireless only.' }])).toBe(
      [
        'The person just added while you were working:',
        '> Wireless only.',
        'Take this into account and carry on with the task; change course if it asks you to.',
      ].join('\n'),
    );
  });
});
