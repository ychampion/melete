import { describe, expect, test } from 'bun:test';
import { PROCEDURE_CHECK_KINDS, type ProcedureCheck, procedureCheck } from '@melete/contracts';
import { type CheckContext, MAX_OUTPUT_CHARS, runChecks } from './checks.ts';

const check = (raw: unknown) => procedureCheck.parse(raw);
const verdict = (raw: unknown, context: CheckContext | string) =>
  runChecks([check(raw)], typeof context === 'string' ? { output: context } : context);
const passes = (raw: unknown, context: CheckContext | string) => verdict(raw, context).score === 1;

const table = {
  columns: ['id', 'amount'],
  rows: [
    { id: 'a', amount: 2 },
    { id: 'b', amount: 10 },
  ],
};

describe('the closed check language', () => {
  test('word_count reads whitespace tokens', () => {
    expect(passes({ kind: 'word_count', max: 5 }, 'one two three')).toBe(true);
    expect(passes({ kind: 'word_count', max: 2 }, 'one two three')).toBe(false);
    expect(passes({ kind: 'word_count', min: 3 }, 'one two three')).toBe(true);
    expect(passes({ kind: 'word_count', min: 4 }, 'one\ttwo\nthree')).toBe(false);
  });

  test('char_count reads UTF-16 length', () => {
    expect(passes({ kind: 'char_count', max: 5 }, 'abcde')).toBe(true);
    expect(passes({ kind: 'char_count', max: 4 }, 'abcde')).toBe(false);
    expect(passes({ kind: 'char_count', min: 1 }, '')).toBe(false);
  });

  test('line_count reads non-empty lines', () => {
    expect(passes({ kind: 'line_count', max: 2 }, 'first\n\n\nsecond\n')).toBe(true);
    expect(passes({ kind: 'line_count', min: 3 }, 'first\n\n\nsecond\n')).toBe(false);
  });

  test('required_phrase matches after normalisation', () => {
    expect(passes({ kind: 'required_phrase', phrase: 'next steps' }, 'The  Next Steps: two')).toBe(
      true,
    );
    expect(passes({ kind: 'required_phrase', phrase: 'next steps' }, 'nothing here')).toBe(false);
  });

  test('forbidden_phrase fails when the phrase is present', () => {
    expect(passes({ kind: 'forbidden_phrase', phrase: 'as an assistant' }, 'plain answer')).toBe(
      true,
    );
    expect(
      passes({ kind: 'forbidden_phrase', phrase: 'as an assistant' }, 'As an assistant, I...'),
    ).toBe(false);
  });

  test('output_format recognises each closed form', () => {
    expect(passes({ kind: 'output_format', form: 'bullets' }, '- one\n- two')).toBe(true);
    expect(passes({ kind: 'output_format', form: 'bullets' }, '- one only')).toBe(false);
    expect(passes({ kind: 'output_format', form: 'numbered' }, '1. one\n2) two')).toBe(true);
    expect(passes({ kind: 'output_format', form: 'numbered' }, '- one\n- two')).toBe(false);
    expect(passes({ kind: 'output_format', form: 'paragraphs' }, 'One idea.\n\nAnother.')).toBe(
      true,
    );
    expect(passes({ kind: 'output_format', form: 'paragraphs' }, 'One idea.\n\n- a\n- b')).toBe(
      false,
    );
    expect(
      passes({ kind: 'output_format', form: 'table' }, '| a | b |\n| --- | --- |\n| 1 | 2 |'),
    ).toBe(true);
    expect(passes({ kind: 'output_format', form: 'table' }, JSON.stringify(table))).toBe(true);
    expect(passes({ kind: 'output_format', form: 'table' }, 'no table here')).toBe(false);
    expect(passes({ kind: 'output_format', form: 'json' }, '{"a":1}')).toBe(true);
    expect(passes({ kind: 'output_format', form: 'json' }, 'not json')).toBe(false);
  });

  test('required_sections wants each heading on its own line, in order', () => {
    const body = '# Summary\nA line.\n\nNext steps:\nAnother line.';
    expect(passes({ kind: 'required_sections', headings: ['Summary', 'Next steps'] }, body)).toBe(
      true,
    );
    expect(passes({ kind: 'required_sections', headings: ['Next steps', 'Summary'] }, body)).toBe(
      false,
    );
    expect(
      passes(
        { kind: 'required_sections', headings: ['Next steps', 'Summary'], ordered: false },
        body,
      ),
    ).toBe(true);
    expect(passes({ kind: 'required_sections', headings: ['Risks'] }, body)).toBe(false);
    // A heading buried inside a sentence is not a heading.
    expect(
      passes({ kind: 'required_sections', headings: ['Summary'] }, 'A Summary of the week.'),
    ).toBe(false);
  });

  test('records_sorted reads the output alone, keeping every input row', () => {
    const sorted = {
      kind: 'records_sorted',
      key: 'amount',
      type: 'number',
      direction: 'ascending',
    };
    const context = { input: { columns: table.columns, rows: table.rows } };
    expect(passes(sorted, { output: JSON.stringify(table), ...context })).toBe(true);
    expect(
      passes(sorted, {
        output: JSON.stringify({ columns: table.columns, rows: [...table.rows].reverse() }),
        ...context,
      }),
    ).toBe(false);
    // Text ordering is the mistake the correction is about: "10" sorts before "2".
    expect(
      passes(
        { ...sorted, type: 'text' },
        { output: JSON.stringify({ columns: table.columns, rows: table.rows }), ...context },
      ),
    ).toBe(false);
    expect(
      passes(sorted, {
        output: JSON.stringify({ columns: table.columns, rows: [table.rows[0]] }),
        ...context,
      }),
    ).toBe(false);
    expect(passes({ ...sorted, preserve_rows: false }, JSON.stringify(table))).toBe(true);
    expect(passes(sorted, { output: JSON.stringify(table) })).toBe(false);
    expect(passes(sorted, { output: 'not json', ...context })).toBe(false);
    const dated = {
      columns: ['id', 'when'],
      rows: [
        { id: 'a', when: '2026-01-02' },
        { id: 'b', when: '2026-02-01' },
      ],
    };
    expect(
      passes(
        { kind: 'records_sorted', key: 'when', type: 'date', direction: 'descending' },
        { output: JSON.stringify(dated), input: { columns: dated.columns, rows: dated.rows } },
      ),
    ).toBe(false);
  });

  test('records_expected_order needs identities only a bundled suite can supply', () => {
    const output = JSON.stringify(table);
    const context = {
      output,
      input: { columns: table.columns, rows: table.rows },
      expected: { row_ids: ['a', 'b'] },
    };
    expect(runChecks([check({ kind: 'records_expected_order' })], context).score).toBe(1);
    expect(
      runChecks([check({ kind: 'records_expected_order' })], {
        ...context,
        expected: { row_ids: ['b', 'a'] },
      }).score,
    ).toBe(0);
    expect(runChecks([check({ kind: 'records_expected_order' })], { output }).score).toBe(0);
  });

  test('action_kind_absent counts only the states a run actually reached', () => {
    const actions = [
      { kind: 'email.send', effectClass: 'external_write', status: 'completed' },
      { kind: 'email.send', effectClass: 'external_write', status: 'rejected' },
    ];
    expect(passes({ kind: 'action_kind_absent', action_kind: 'email.send' }, { output: 'x' })).toBe(
      true,
    );
    expect(
      passes({ kind: 'action_kind_absent', action_kind: 'email.send' }, { output: 'x', actions }),
    ).toBe(false);
    expect(
      passes({ kind: 'action_kind_absent', action_kind: 'files.write' }, { output: 'x', actions }),
    ).toBe(true);
  });

  test('action_kind_max bounds how often a kind ran', () => {
    const actions = [
      { kind: 'email.search', effectClass: 'read', status: 'completed' },
      { kind: 'email.search', effectClass: 'read', status: 'dispatched' },
    ];
    expect(
      passes(
        { kind: 'action_kind_max', action_kind: 'email.search', max: 2 },
        { output: 'x', actions },
      ),
    ).toBe(true);
    expect(
      passes(
        { kind: 'action_kind_max', action_kind: 'email.search', max: 1 },
        { output: 'x', actions },
      ),
    ).toBe(false);
  });

  test('action_kind_present wants the kind to have run', () => {
    const actions = [{ kind: 'files.read', effectClass: 'read', status: 'proposed' }];
    expect(
      passes({ kind: 'action_kind_present', action_kind: 'files.read' }, { output: 'x', actions }),
    ).toBe(true);
    expect(
      passes(
        { kind: 'action_kind_present', action_kind: 'files.read', min: 2 },
        { output: 'x', actions },
      ),
    ).toBe(false);
    expect(
      passes({ kind: 'action_kind_present', action_kind: 'files.read' }, { output: 'x' }),
    ).toBe(false);
  });

  test('every declared kind has semantics and a report shape', () => {
    const report = runChecks(
      [check({ kind: 'word_count', max: 3 }), check({ kind: 'required_phrase', phrase: 'hello' })],
      { output: 'one two three four' },
    );
    expect(report.score).toBe(0);
    expect(report.corrections).toBe(2);
    expect(report.results.map((result) => result.kind)).toEqual(['word_count', 'required_phrase']);
    expect(report.results.every((result) => typeof result.detail === 'string')).toBe(true);
    expect(runChecks([], { output: 'anything' })).toEqual({
      score: 1,
      corrections: 0,
      results: [],
    });
    const covered = new Set<string>();
    for (const kind of PROCEDURE_CHECK_KINDS) covered.add(kind);
    expect(covered.size).toBe(PROCEDURE_CHECK_KINDS.length);
  });

  test('an output over 64 KiB fails closed', () => {
    const huge = 'a'.repeat(MAX_OUTPUT_CHARS + 1);
    const report = runChecks(
      [check({ kind: 'char_count', min: 1 }), check({ kind: 'forbidden_phrase', phrase: 'zzz' })],
      { output: huge },
    );
    expect(report.score).toBe(0);
    expect(report.corrections).toBe(2);
    expect(report.results.every((result) => result.detail === 'output_too_large')).toBe(true);
    // The same checks pass one character below the cap, so the cap is what refused them.
    expect(
      runChecks(
        [check({ kind: 'char_count', min: 1 }), check({ kind: 'forbidden_phrase', phrase: 'zzz' })],
        { output: 'a'.repeat(MAX_OUTPUT_CHARS) },
      ).score,
    ).toBe(1);
  });

  test('more than six checks fail closed', () => {
    const many = Array.from({ length: 7 }, () => check({ kind: 'char_count', min: 0 }));
    expect(runChecks(many, { output: 'fine' }).corrections).toBe(7);
    expect(runChecks(many.slice(0, 6), { output: 'fine' }).score).toBe(1);
  });

  test('no check kind accepts a pattern from the model', () => {
    for (const raw of [
      { kind: 'regex', pattern: '.*' },
      { kind: 'required_phrase', phrase: 'ok', pattern: '(a+)+$' },
      { kind: 'output_format', form: 'markdown' },
      { kind: 'required_phrase', phrase: 'a'.repeat(61) },
      { kind: 'word_count' },
      { kind: 'word_count', min: 10, max: 2 },
      { kind: 'action_kind_max', action_kind: 'email.send', max: 21 },
      { kind: 'required_sections', headings: [] },
      { kind: 'script', body: 'return true' },
    ])
      expect(procedureCheck.safeParse(raw).success).toBe(false);
    const text = JSON.stringify(procedureCheck);
    for (const kind of PROCEDURE_CHECK_KINDS) expect(typeof kind).toBe('string');
    expect(text).not.toContain('regex');
    const shapes: ProcedureCheck[] = [
      check({ kind: 'required_phrase', phrase: 'next steps' }),
      check({ kind: 'output_format', form: 'bullets' }),
    ];
    expect(
      shapes.every((shape) => Object.values(shape).every((value) => typeof value !== 'function')),
    ).toBe(true);
  });
});
