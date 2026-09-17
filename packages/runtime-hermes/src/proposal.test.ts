import { describe, expect, test } from 'bun:test';
import type { ToolSpec } from '@melete/contracts';
import { asksWithoutProposing } from './proposal.ts';

const tool = (name: string, effect_class: ToolSpec['effect_class']): ToolSpec => ({
  name,
  description: name,
  input_schema: { type: 'object' },
  effect_class,
  connection_id: effect_class === 'read' ? null : 'conn_01J8ZP3QWABCDEFGHJKMNPQRST',
});
const catalog = [
  tool('email.search', 'read'),
  tool('email.draft', 'write_reversible'),
  tool('email.send', 'write_external'),
  tool('job.wait', 'write_reversible'),
  tool('payments.pay', 'spend'),
  tool('tracker_create_issue', 'write_external'),
];

describe('a go-ahead ask for an effect nobody proposed', () => {
  test('asks that name an uncalled external verb count', () => {
    for (const reply of [
      'Shall I send it?',
      'Would you like me to send the confirmation now?',
      'I found the invoice. Can I pay it today?',
      'Let me know if I should send the reply.',
      'Should I create the issue for this?',
      'The reply is ready to send once you approve.',
    ])
      expect(asksWithoutProposing(reply, ['email.search'], catalog)).toBe(true);
  });

  test('a draft beside its uncalled send makes a bare go-ahead count', () => {
    expect(asksWithoutProposing('Want me to go ahead?', ['email.draft'], catalog)).toBe(true);
    expect(asksWithoutProposing('Want me to go ahead?', [], catalog)).toBe(false);
  });

  test('closing offers, value questions, refusals and reports do not count', () => {
    for (const reply of [
      'Done. Let me know if you need anything else.',
      'Which address should I use, work or personal?',
      'Should I wait for the reply before doing anything?',
      'Shall I summarize the thread instead?',
      "I can't send mail from here, so nothing was sent.",
      'I sent the reply yesterday and the receipt is recorded.',
      'Anything else I can help with?',
    ])
      expect(asksWithoutProposing(reply, ['email.search'], catalog)).toBe(false);
  });

  test('an attempt that called an external tool, or had none to call, is not asked again', () => {
    expect(asksWithoutProposing('Shall I send another?', ['email.send'], catalog)).toBe(false);
    expect(asksWithoutProposing('Shall I send it?', [], [tool('email.search', 'read')])).toBe(
      false,
    );
  });
});
