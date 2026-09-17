import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AdmissionError } from './admit.ts';
import { refusalCode } from './proposer.ts';

describe('the ledger refusal code', () => {
  test('names the rule that refused the answer', () => {
    expect(refusalCode(new AdmissionError('authority_language:approve', 'message'))).toBe(
      'authority_language:approve',
    );
    expect(refusalCode(new AdmissionError('span_not_verbatim', 'message'))).toBe(
      'span_not_verbatim',
    );
    expect(refusalCode(z.object({ a: z.string() }).safeParse({}).error)).toBe(
      'proposal_schema_invalid',
    );
    expect(refusalCode(new Error('answer_not_json'))).toBe('answer_not_json');
  });

  test('never carries the text of what was refused', () => {
    for (const error of [
      new Error('Unexpected token P in "PRIVATE-OWNER-TEXT email finance@x.com"'),
      new Error('PLANTED'),
      'a thrown string with content',
      { message: 'not_an_error' },
    ])
      expect(refusalCode(error)).toBe('proposal_failed');
  });
});
