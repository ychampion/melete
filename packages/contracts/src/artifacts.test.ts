import { describe, expect, test } from 'bun:test';
import { artifactCheckName, artifactExpectation, artifactValidationsHold } from './artifacts.ts';

describe('declared checks have distinct identities', () => {
  test('two checks that would produce the same result name are refused', () => {
    const twice = {
      kind: 'csv',
      checks: [
        { kind: 'totals', column: 'amount', total_label: 'Total' },
        { kind: 'totals', column: 'Amount', equals: 10 },
      ],
    };
    // Silently keeping the last one means a declared check vanishes and the
    // artifact passes on a promise nobody made.
    expect(() => artifactExpectation.parse(twice)).toThrow(/totals:amount/);
    expect(() =>
      artifactExpectation.parse({
        kind: 'csv',
        checks: [{ kind: 'non_empty' }, { kind: 'non_empty' }],
      }),
    ).toThrow(/non_empty/);
  });

  test('checks on different columns are distinct and allowed', () => {
    const parsed = artifactExpectation.parse({
      kind: 'csv',
      checks: [
        { kind: 'totals', column: 'amount' },
        { kind: 'totals', column: 'hours' },
      ],
    });
    expect(parsed.checks.map(artifactCheckName)).toEqual(['totals:amount', 'totals:hours']);
  });
});

describe('an unavailable result only passes when it is advisory', () => {
  test('a required validator that could not run does not count as passed', () => {
    expect(artifactValidationsHold([{ status: 'unavailable', advisory: false }])).toBe(false);
    expect(artifactValidationsHold([{ status: 'unavailable', advisory: true }])).toBe(true);
    expect(artifactValidationsHold([{ status: 'passed', advisory: false }])).toBe(true);
  });
});
