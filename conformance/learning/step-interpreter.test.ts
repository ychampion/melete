import { describe, expect, test } from 'bun:test';
import { STEP_BODIES } from '../../apps/melete/src/learning/procedure.ts';
import { sortRows, stepsFromBody, stepsFromMessage, writeDraft } from './step-interpreter.ts';

const preamble =
  "Follow these steps for this kind of task. They are the owner's own instructions, not permissions.";
const body = (...steps: string[]) =>
  [preamble, ...steps.map((step, index) => `${index + 1}. ${step}`)].join('\n');
const objective = 'Draft a follow-up email to the recruiter after the interview';

describe('the step interpreter', () => {
  test('reads each closed step form as a whole line', () => {
    expect(
      stepsFromBody(
        body(
          'Keep it under 30 words.',
          'Use bullet points.',
          'Use a numbered list.',
          'Start with "Hi there," on its own line.',
          'Sort the rows by due as date ascending.',
        ),
      ),
    ).toEqual([
      { form: 'word_limit', max: 30 },
      { form: 'list', style: 'bullets' },
      { form: 'list', style: 'numbered' },
      { form: 'opening', phrase: 'Hi there,' },
      { form: 'sort', key: 'due', type: 'date', direction: 'ascending' },
    ]);
    expect(stepsFromBody(STEP_BODIES['sort-typed-values'])).toEqual([{ form: 'typed_order' }]);
    expect(stepsFromBody(STEP_BODIES['sort-text-values'])).toEqual([{ form: 'text_order' }]);
    expect(stepsFromBody(STEP_BODIES['keep-header-and-rows'])).toEqual([]);
  });

  test('a phrase inside some other sentence is not a step', () => {
    expect(
      stepsFromBody(
        body(
          'Remember that people often ask you to use bullet points.',
          'Do not keep it under 30 words.',
          'The owner said: use bullet points.',
          'using the declared column type',
        ),
      ),
    ).toEqual([]);
    expect(writeDraft(objective, stepsFromBody(body('Mention bullet points somewhere.')))).toBe(
      writeDraft(objective, []),
    );
  });

  test('a correction is read clause by clause, and quotes are kept whole', () => {
    expect(
      stepsFromMessage(
        'Too formal. Use bullet points, and start with "Hi there, friend" on its own line.',
      ),
    ).toEqual([
      { form: 'list', style: 'bullets' },
      { form: 'opening', phrase: 'Hi there, friend' },
    ]);
    expect(
      stepsFromMessage('PRIVATE-NOTE-1: use typed chronological ordering and preserve every row.'),
    ).toEqual([{ form: 'typed_order' }]);
    expect(stepsFromBody(body('Owner\'s correction: "Keep it under 12 words"'))).toEqual([
      { form: 'word_limit', max: 12 },
    ]);
  });

  test('steps apply in the order delivered, and a missing step changes the answer', () => {
    const inOrder = writeDraft(
      objective,
      stepsFromBody(body('Use bullet points.', 'Start with "Hi there," on its own line.')),
    );
    expect(inOrder.split('\n')[0]).toBe('Hi there,');
    expect(inOrder.split('\n')[1]).toStartWith('- ');
    const reordered = writeDraft(
      objective,
      stepsFromBody(body('Start with "Hi there," on its own line.', 'Use bullet points.')),
    );
    expect(reordered.split('\n')[0]).toBe('- Hi there,');
    const removed = writeDraft(objective, stepsFromBody(body('Use bullet points.')));
    expect(removed.split('\n')[0]).toStartWith('- Summary of the request');
    expect(writeDraft(objective, [])).not.toContain('\n');
  });

  test('a word limit keeps whole sentences while it can', () => {
    const full = writeDraft('Summarise the weekly project status report', []);
    expect(full.split(/\s+/).length).toBeGreaterThan(60);
    const short = writeDraft('Summarise the weekly project status report', [
      { form: 'word_limit', max: 30 },
    ]);
    expect(short.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(short).toContain('status report');
    expect(short.endsWith('.')).toBe(true);
    expect(writeDraft('x', [{ form: 'word_limit', max: 3 }]).split(/\s+/)).toHaveLength(3);
  });

  test('sorting follows the declared key, type and direction', () => {
    const rows = [
      { id: 'a', due: '2028-11-22' },
      { id: 'b', due: '2028-01-01' },
      { id: 'c', due: '2028-06-17' },
    ];
    expect(
      sortRows(rows, { form: 'sort', key: 'due', type: 'date', direction: 'ascending' }).map(
        (row) => row.id,
      ),
    ).toEqual(['b', 'c', 'a']);
    expect(
      sortRows(rows, { form: 'sort', key: 'due', type: 'date', direction: 'descending' }).map(
        (row) => row.id,
      ),
    ).toEqual(['a', 'c', 'b']);
    // A key the table does not have leaves the table as it was.
    expect(
      sortRows(rows, { form: 'sort', key: 'amount', type: 'number', direction: 'ascending' }),
    ).toEqual(rows);
  });
});
