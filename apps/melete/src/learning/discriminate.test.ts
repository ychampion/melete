import { describe, expect, test } from 'bun:test';
import { type ProcedureCheck, procedureCheck } from '@melete/contracts';
import { discriminate, JUNK_OUTPUT } from './discriminate.ts';

const checks = (...raw: unknown[]): ProcedureCheck[] =>
  raw.map((item) => procedureCheck.parse(item));
const prior =
  'Dear Mr Alvarez,\nI hope this email finds you well. I wanted to follow up on the role.';
const corrected = '- Thanks for the interview on Tuesday\n- Happy to share references';

describe('whether checks discriminate', () => {
  test('checks that tell the corrected answer from the objected one pass', () => {
    const result = discriminate(
      checks(
        { kind: 'output_format', form: 'bullets' },
        { kind: 'forbidden_phrase', phrase: 'I hope this email finds you well' },
      ),
      { prior, corrected },
    );
    expect(result).toEqual({
      status: 'passed',
      detail: 'discriminates',
      prior_failed: 2,
      corrected_failed: 0,
      empty_failed: 1,
      junk_failed: 1,
    });
  });

  test('checks that pass the pre-correction output do not discriminate', () => {
    // Both answers are under the limit, so the limit measured nothing the owner cared about.
    const result = discriminate(checks({ kind: 'word_count', min: 3, max: 200 }), {
      prior,
      corrected,
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toBe('prior_output_passes');
    expect(result.prior_failed).toBe(0);
  });

  test('the corrected output must pass every check', () => {
    const result = discriminate(
      checks(
        { kind: 'output_format', form: 'bullets' },
        { kind: 'required_phrase', phrase: 'next steps' },
      ),
      { prior, corrected },
    );
    expect(result).toMatchObject({ status: 'failed', detail: 'corrected_output_fails' });
  });

  test('an empty output must fail', () => {
    // A forbidden phrase alone is satisfied by saying nothing at all.
    const result = discriminate(
      checks({ kind: 'forbidden_phrase', phrase: 'I hope this email finds you well' }),
      { prior, corrected },
    );
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'empty_output_passes',
      empty_failed: 0,
    });
  });

  test('a constant junk output must fail', () => {
    // Non-empty is not a property of a good answer: the constant lazy reply has it too.
    const result = discriminate(
      checks(
        { kind: 'char_count', min: 1 },
        { kind: 'forbidden_phrase', phrase: 'I hope this email finds you well' },
      ),
      { prior, corrected },
    );
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'junk_output_passes',
      junk_failed: 0,
    });
    expect(JUNK_OUTPUT.length).toBeGreaterThan(0);
  });

  test('missing recorded outputs cannot discriminate', () => {
    const bulleted = checks({ kind: 'output_format', form: 'bullets' });
    expect(discriminate(bulleted, { prior: null, corrected })).toMatchObject({
      status: 'failed',
      detail: 'prior_output_unavailable',
    });
    expect(discriminate(bulleted, { prior, corrected: null })).toMatchObject({
      status: 'failed',
      detail: 'corrected_output_unavailable',
    });
  });

  test('no checks is recorded as none, not as a pass', () => {
    expect(discriminate([], { prior, corrected })).toEqual({
      status: 'none',
      detail: 'no_checks',
      prior_failed: null,
      corrected_failed: null,
      empty_failed: 0,
      junk_failed: 0,
    });
  });

  test('action checks discriminate on the actions each answer came with', () => {
    const result = discriminate(
      checks(
        { kind: 'action_kind_absent', action_kind: 'files.delete' },
        { kind: 'required_phrase', phrase: 'archive' },
      ),
      {
        prior: 'Deleted 40 old files.',
        corrected: 'Moved 40 old files to the archive folder.',
        priorActions: [{ kind: 'files.delete', effectClass: 'destructive', status: 'succeeded' }],
        correctedActions: [
          { kind: 'files.move', effectClass: 'write_reversible', status: 'succeeded' },
        ],
      },
    );
    expect(result).toMatchObject({ status: 'passed', prior_failed: 2, corrected_failed: 0 });
  });
});
