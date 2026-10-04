/**
 * Watch predicates.
 *
 * A monitor that wakes a model every five minutes to look at an unchanged inbox
 * is not watching, it is spending. A watch is the other thing: a small
 * deterministic test the service evaluates against a typed connector
 * observation the moment it arrives. If it does not match, nothing happens: no
 * attempt, no model call, no row. If it matches, the job wakes with that
 * observation as its evidence and `because` set to the observation's handle.
 *
 * The language is deliberately too small to hide a decision in. Five clauses,
 * a handful of operators, field paths only, values that are strings or numbers
 * or booleans. Anything a person would want that this cannot say is a thing the
 * model should be woken for, not a thing the DSL should grow an operator for.
 *
 * Three operators read the clock: `before` and `after` compare a time field
 * with now plus an offset in seconds, and `older_than` asks whether a time
 * field is more than that many seconds in the past. Without a clock to read,
 * they are false. A fourth, `absent`, is for clocks alone: it holds when
 * nothing of the kind it names has been seen about the clock's subject, and a
 * trigger cannot use it.
 */
import { RE2JS } from 're2js';
import { z } from 'zod';

/**
 * What a trigger's watch may test. `changed` needs the previous observation;
 * `before`, `after` and `older_than` need the time now; the rest read only the
 * current observation.
 */
export const WATCH_OPERATORS = [
  'eq',
  'contains',
  'matches',
  'lt',
  'gt',
  'changed',
  'before',
  'after',
  'older_than',
] as const;
/** Clocks may also test that something did not happen. */
export const CLOCK_OPERATORS = [...WATCH_OPERATORS, 'absent'] as const;
export const watchOperator = z.enum(CLOCK_OPERATORS);
export type WatchOperator = z.infer<typeof watchOperator>;

/** The operators that compare a time field with the clock. */
export const TIME_OPERATORS: readonly WatchOperator[] = ['before', 'after', 'older_than'];

/** The furthest a time comparison or an absence may reach, either way: a year. */
export const MAX_WATCH_OFFSET_SECONDS = 366 * 86_400;

/**
 * A dotted path into the observation payload: `subject`, `from.address`,
 * `headers.x-priority`. Array indices are not addressable, because a predicate
 * that depends on the order a connector returned things is not deterministic.
 */
export const watchField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/, 'must be a dotted field path');

export const watchValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
export type WatchValue = z.infer<typeof watchValue>;

export const watchClause = z.object({
  /** For `absent`, the kind that must not have been seen, such as `mail.received`. */
  field: watchField,
  op: watchOperator,
  /**
   * Ignored by `changed`, which compares the field against the last
   * observation. For `before` and `after`, an offset from now in seconds
   * (negative for the past); for `older_than`, an age in seconds; for
   * `absent`, how far back to look in seconds, or null for "since the clock
   * was set".
   */
  value: watchValue.default(null),
});
export type WatchClause = z.infer<typeof watchClause>;

export const MAX_WATCH_CLAUSES = 5;

/**
 * Every clause in `all`, and, when `any` is given, at least one of its
 * clauses. Five clauses in all, at most, and one `any` group: "declined or
 * cancelled" is common enough to say in one watch, and anything wider is two
 * watches, which keeps every wake traceable to one predicate a person can read.
 */
export const watchPredicate = z
  .object({
    all: z.array(watchClause).max(MAX_WATCH_CLAUSES).default([]),
    any: z.array(watchClause).min(2).max(MAX_WATCH_CLAUSES).optional(),
  })
  .refine(
    (predicate) => {
      const count = predicate.all.length + (predicate.any?.length ?? 0);
      return count >= 1 && count <= MAX_WATCH_CLAUSES;
    },
    { message: `a watch has between 1 and ${MAX_WATCH_CLAUSES} clauses in all` },
  );
export type WatchPredicate = z.infer<typeof watchPredicate>;

const withinOffset = (value: unknown, signed: boolean): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  Math.abs(value) <= MAX_WATCH_OFFSET_SECONDS &&
  (signed || value >= 0);

/**
 * Why a predicate cannot be used where it is offered, or null when it can. A
 * time operator needs a whole number of seconds within a year; `absent` is for
 * clocks alone, and takes null or such a number.
 */
export function watchPredicateProblem(
  predicate: WatchPredicate,
  use: 'trigger' | 'clock',
): string | null {
  for (const clause of [...predicate.all, ...(predicate.any ?? [])]) {
    if (clause.op === 'absent') {
      if (use === 'trigger')
        return `${clause.field}: "absent" is for deadlines Melete keeps, not for a watch.`;
      if (clause.value !== null && !withinOffset(clause.value, false))
        return `${clause.field}: "absent" looks back a whole number of seconds, up to a year.`;
    }
    if (
      TIME_OPERATORS.includes(clause.op) &&
      !withinOffset(clause.value, clause.op !== 'older_than')
    )
      return `${clause.field}: "${clause.op}" takes a whole number of seconds${
        clause.op === 'older_than' ? '' : ' from now'
      }, up to a year.`;
  }
  return null;
}

/**
 * What evaluation may read beside the observation: the time now, for the time
 * operators, and for `absent`, whether a kind was seen since a moment.
 */
export type WatchContext = {
  now?: number;
  /** True when something of `kind` was seen about the subject since `sinceMs` (null: since the clock was set). */
  seen?: (kind: string, sinceMs: number | null) => boolean;
};

/** A connector observation, as the connector reported it. Never model output. */
export type WatchObservation = Record<string, unknown>;

/**
 * Read a dotted path. Only plain objects are traversed: an array in the middle
 * of a path stops the walk, because indexing into connector output would make a
 * predicate depend on the order a feed happened to return things.
 */
export function readWatchField(observation: unknown, path: string): unknown {
  let current: unknown = observation;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The longest text a predicate will scan, so one huge body cannot stall a wake. */
export const WATCH_MAX_SCAN = 8192;

/** Creation and evaluation use the same non-backtracking regex grammar. */
export function compileWatchPattern(pattern: string): RE2JS {
  if (pattern.length > 1000) throw new Error('watch pattern exceeds 1000 characters');
  return RE2JS.compile(pattern);
}

const asComparable = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * One clause against one observation. Every unclear case is false: a missing
 * field, a comparison between things that are not comparable, a pattern that
 * does not compile. A watch that cannot tell is a watch that does not wake, and
 * the person keeps their quiet.
 */
export function evaluateWatchClause(
  clause: WatchClause,
  observation: WatchObservation,
  previous: WatchObservation | null = null,
  context: WatchContext = {},
): boolean {
  const actual = readWatchField(observation, clause.field);
  switch (clause.op) {
    case 'before':
    case 'after':
    case 'older_than': {
      // No clock, an offset that is not one, or a field that is not a time: no wake.
      if (context.now === undefined || typeof actual !== 'string') return false;
      const at = Date.parse(actual);
      if (Number.isNaN(at) || !withinOffset(clause.value, clause.op !== 'older_than')) return false;
      const offset = clause.value * 1000;
      if (clause.op === 'before') return at < context.now + offset;
      if (clause.op === 'after') return at > context.now + offset;
      return at < context.now - offset;
    }
    case 'absent': {
      // Only a clock can say what was not seen; anywhere else it cannot tell.
      if (!context.seen) return false;
      if (clause.value === null) return !context.seen(clause.field, null);
      if (context.now === undefined || !withinOffset(clause.value, false)) return false;
      return !context.seen(clause.field, context.now - clause.value * 1000);
    }
    case 'changed': {
      // With nothing to compare against there is no evidence of a change.
      if (!previous) return false;
      return !sameValue(actual, readWatchField(previous, clause.field));
    }
    case 'eq':
      return sameValue(actual, clause.value);
    case 'contains': {
      if (typeof clause.value !== 'string') return false;
      if (typeof actual === 'string') return actual.slice(0, WATCH_MAX_SCAN).includes(clause.value);
      if (Array.isArray(actual)) return actual.some((item) => sameValue(item, clause.value));
      return false;
    }
    case 'matches': {
      if (typeof clause.value !== 'string' || typeof actual !== 'string') return false;
      try {
        return compileWatchPattern(clause.value).matcher(actual.slice(0, WATCH_MAX_SCAN)).find();
      } catch {
        return false;
      }
    }
    case 'lt':
    case 'gt': {
      const left = asComparable(actual);
      const right = asComparable(clause.value);
      if (left === null || right === null) return false;
      return clause.op === 'lt' ? left < right : left > right;
    }
  }
}

/** Every clause in `all` and, when there is an `any`, one of its clauses; or no wake. */
export function evaluateWatch(
  predicate: WatchPredicate,
  observation: WatchObservation,
  previous: WatchObservation | null = null,
  context: WatchContext = {},
): boolean {
  const all = predicate.all ?? [];
  const any = predicate.any ?? [];
  if (all.length + any.length === 0) return false;
  return (
    all.every((clause) => evaluateWatchClause(clause, observation, previous, context)) &&
    (any.length === 0 ||
      any.some((clause) => evaluateWatchClause(clause, observation, previous, context)))
  );
}
