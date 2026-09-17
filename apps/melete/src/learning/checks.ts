/**
 * The check language, evaluated by trusted code over one job's final output and
 * its action rows. Nothing here reads a file, a database or a model: a check is
 * a value the admission step already validated against a closed union, and
 * running it is a pure function of that value and the run.
 *
 * Every kind is linear in the length of the output and does no backtracking, so
 * a candidate cannot make grading expensive. An output past the read cap fails
 * every check rather than being truncated, because a check that silently graded
 * half an answer would be worse than one that refused.
 */
import { normalizeForMatch, type ProcedureCheck } from '@melete/contracts';
import { gradeRecords, type RecordCase } from '../../../../conformance/learning/records.ts';

export const MAX_OUTPUT_CHARS = 65536;
export const MAX_CHECKS = 6;

export type RecordRow = Record<string, string | number>;
export type ActionFact = { kind: string; effectClass: string; status: string };
/** Only these count: a refused or failed proposal is not something the run did. */
const COUNTED_ACTION_STATES = new Set(['proposed', 'dispatched', 'completed']);

export type CheckContext = {
  output: string;
  actions?: readonly ActionFact[];
  /** The case's own input rows, so `preserve_rows` needs no answer key. */
  input?: { columns: readonly string[]; rows: readonly RecordRow[] };
  /** Fixture-declared row identities. Only a bundled suite supplies this. */
  expected?: { row_ids: readonly string[] };
};
export type CheckResult = { kind: string; passed: boolean; detail: string };
export type CheckReport = { score: 0 | 1; corrections: number; results: CheckResult[] };

const fail = (kind: string, detail: string): CheckResult => ({ kind, passed: false, detail });
const pass = (kind: string, detail: string): CheckResult => ({ kind, passed: true, detail });
const decide = (kind: string, ok: boolean, detail: string) =>
  ok ? pass(kind, detail) : fail(kind, detail);

const BULLET_LINE = /^\s*[-*•]\s+\S/;
const NUMBERED_LINE = /^\s*\d+[.)]\s+\S/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

const words = (text: string) => {
  let count = 0;
  let inWord = false;
  for (const character of text) {
    const space =
      character === ' ' || character === '\n' || character === '\t' || character === '\r';
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      count += 1;
    }
  }
  return count;
};
const lines = (text: string) => text.split('\n');
const nonEmptyLines = (text: string) => lines(text).filter((line) => line.trim().length > 0);

const withinBounds = (value: number, min?: number, max?: number) =>
  (min === undefined || value >= min) && (max === undefined || value <= max);
const boundsDetail = (label: string, value: number, min?: number, max?: number) =>
  `${label} ${value}, wanted ${min ?? 'any'}..${max ?? 'any'}`;

/** A heading counts when it is its own line, with an optional `#` prefix or `:` suffix. */
const headingIndex = (text: string, heading: string) => {
  const needle = normalizeForMatch(heading);
  if (!needle) return -1;
  const all = lines(text);
  for (let index = 0; index < all.length; index += 1) {
    const line = (all[index] ?? '')
      .trim()
      .replace(/^#+\s*/, '')
      .replace(/:\s*$/, '');
    if (normalizeForMatch(line) === needle) return index;
  }
  return -1;
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isRecordOutput = (
  value: unknown,
): value is { columns: unknown[]; rows: Record<string, unknown>[] } =>
  !!value &&
  typeof value === 'object' &&
  Array.isArray((value as { columns?: unknown }).columns) &&
  Array.isArray((value as { rows?: unknown }).rows);

const canonicalRow = (row: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );

/** Same multiset of rows, regardless of order: a sort may not add, drop or edit a row. */
const sameRows = (left: readonly Record<string, unknown>[], right: readonly RecordRow[]) => {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const row of right) counts.set(canonicalRow(row), (counts.get(canonicalRow(row)) ?? 0) + 1);
  for (const row of left) {
    const key = canonicalRow(row);
    const seen = counts.get(key);
    if (!seen) return false;
    counts.set(key, seen - 1);
  }
  return true;
};

/** Deterministic and locale-free: two machines must grade the same output the same way. */
const comparable = (value: unknown, type: 'number' | 'text' | 'date'): number | string | null => {
  if (value === null || value === undefined) return null;
  if (type === 'number') {
    const number = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  }
  if (type === 'date') {
    const instant = Date.parse(String(value));
    return Number.isFinite(instant) ? instant : null;
  }
  return String(value);
};

const actionCount = (context: CheckContext, kind: string) =>
  (context.actions ?? []).filter(
    (row) => row.kind === kind && COUNTED_ACTION_STATES.has(row.status),
  ).length;

function runCheck(check: ProcedureCheck, context: CheckContext): CheckResult {
  const output = context.output;
  switch (check.kind) {
    case 'word_count': {
      const value = words(output);
      return decide(
        check.kind,
        withinBounds(value, check.min, check.max),
        boundsDetail('words', value, check.min, check.max),
      );
    }
    case 'char_count': {
      const value = output.length;
      return decide(
        check.kind,
        withinBounds(value, check.min, check.max),
        boundsDetail('characters', value, check.min, check.max),
      );
    }
    case 'line_count': {
      const value = nonEmptyLines(output).length;
      return decide(
        check.kind,
        withinBounds(value, check.min, check.max),
        boundsDetail('lines', value, check.min, check.max),
      );
    }
    case 'required_phrase': {
      const found = normalizeForMatch(output).includes(normalizeForMatch(check.phrase));
      return decide(check.kind, found, found ? 'the phrase is present' : 'the phrase is missing');
    }
    case 'forbidden_phrase': {
      const found = normalizeForMatch(output).includes(normalizeForMatch(check.phrase));
      return decide(check.kind, !found, found ? 'the phrase is present' : 'the phrase is absent');
    }
    case 'output_format': {
      const all = lines(output);
      const bullets = all.filter((line) => BULLET_LINE.test(line)).length;
      const numbered = all.filter((line) => NUMBERED_LINE.test(line)).length;
      if (check.form === 'bullets')
        return decide(check.kind, bullets >= 2, `${bullets} bullet lines`);
      if (check.form === 'numbered')
        return decide(check.kind, numbered >= 2, `${numbered} numbered lines`);
      if (check.form === 'paragraphs') {
        const blocks = output.split(/\n\s*\n/).filter((block) => block.trim().length > 0);
        return decide(
          check.kind,
          blocks.length >= 1 && bullets === 0 && numbered === 0,
          `${blocks.length} blocks, ${bullets + numbered} list lines`,
        );
      }
      if (check.form === 'json') {
        const value = parsed(output.trim());
        return decide(
          check.kind,
          value !== undefined && value !== null && typeof value === 'object',
          'a JSON object or array',
        );
      }
      const piped = all.filter((line) => line.includes('|')).length;
      const separators = all.filter((line) => line.includes('|') && TABLE_SEPARATOR.test(line));
      const structured = isRecordOutput(parsed(output.trim()));
      return decide(
        check.kind,
        (piped >= 2 && separators.length >= 1) || structured,
        structured ? 'columns and rows' : `${piped} piped lines, ${separators.length} separators`,
      );
    }
    case 'required_sections': {
      const positions = check.headings.map((heading) => headingIndex(output, heading));
      const missing = check.headings.filter((_, index) => positions[index] === -1);
      if (missing.length) return fail(check.kind, `missing ${missing.length} of the headings`);
      if (!check.ordered) return pass(check.kind, 'every heading is present');
      for (let index = 1; index < positions.length; index += 1)
        if ((positions[index] ?? 0) < (positions[index - 1] ?? 0))
          return fail(check.kind, 'the headings are out of order');
      return pass(check.kind, 'every heading is present and in order');
    }
    case 'records_sorted': {
      const value = parsed(output.trim());
      if (!isRecordOutput(value)) return fail(check.kind, 'the output is not columns and rows');
      if (check.preserve_rows) {
        if (!context.input) return fail(check.kind, 'no input rows were supplied');
        if (!sameRows(value.rows, context.input.rows))
          return fail(check.kind, 'the rows are not the input rows');
      }
      const keys = value.rows.map((row) => comparable(row[check.key], check.type));
      if (keys.some((key) => key === null))
        return fail(check.kind, `a value under ${check.key} is not a ${check.type}`);
      for (let index = 1; index < keys.length; index += 1) {
        const previous = keys[index - 1] as number | string;
        const current = keys[index] as number | string;
        const ordered = check.direction === 'ascending' ? previous <= current : previous >= current;
        if (!ordered)
          return fail(check.kind, `row ${index + 1} breaks the ${check.direction} order`);
      }
      return pass(check.kind, `${keys.length} rows in ${check.direction} order`);
    }
    case 'records_expected_order': {
      if (!context.expected || !context.input)
        return fail(check.kind, 'only a bundled suite supplies the expected identities');
      // The grader compares against fixture-declared identities; it never re-runs a sort.
      const value = {
        template: '',
        task: { columns: [...context.input.columns], rows: [...context.input.rows] },
        expectedIds: [...context.expected.row_ids],
      } as unknown as RecordCase;
      return decide(check.kind, gradeRecords(value, output), 'the fixture row identities');
    }
    case 'action_kind_absent': {
      const count = actionCount(context, check.action_kind);
      return decide(check.kind, count === 0, `${count} ${check.action_kind} actions`);
    }
    case 'action_kind_max': {
      const count = actionCount(context, check.action_kind);
      return decide(check.kind, count <= check.max, `${count} ${check.action_kind} actions`);
    }
    case 'action_kind_present': {
      const count = actionCount(context, check.action_kind);
      return decide(check.kind, count >= check.min, `${count} ${check.action_kind} actions`);
    }
  }
}

/**
 * Every check, in the order the candidate declares them. A failure is one
 * correction the owner would otherwise have had to make, which is what the gate
 * compares between the two arms.
 */
export function runChecks(checks: readonly ProcedureCheck[], context: CheckContext): CheckReport {
  const results =
    checks.length > MAX_CHECKS
      ? checks.map((check) => fail(check.kind, 'too_many_checks'))
      : context.output.length > MAX_OUTPUT_CHARS
        ? checks.map((check) => fail(check.kind, 'output_too_large'))
        : checks.map((check) => runCheck(check, context));
  const corrections = results.filter((result) => !result.passed).length;
  return { score: corrections === 0 ? 1 : 0, corrections, results };
}
