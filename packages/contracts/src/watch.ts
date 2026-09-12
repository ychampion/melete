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
 * six operators, field paths only, values that are strings or numbers or
 * booleans. Anything a person would want that this cannot say is a thing the
 * model should be woken for, not a thing the DSL should grow an operator for.
 */
import { RE2JS } from 're2js';
import { z } from 'zod';

/** `changed` needs the previous observation; the rest read only the current one. */
export const WATCH_OPERATORS = ['eq', 'contains', 'matches', 'lt', 'gt', 'changed'] as const;
export const watchOperator = z.enum(WATCH_OPERATORS);
export type WatchOperator = z.infer<typeof watchOperator>;

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
  field: watchField,
  op: watchOperator,
  /** Ignored by `changed`, which compares the field against the last observation. */
  value: watchValue.default(null),
});
export type WatchClause = z.infer<typeof watchClause>;

export const MAX_WATCH_CLAUSES = 5;

/**
 * All of the clauses, or nothing. There is no `or`: two reasons to wake are two
 * watches, which keeps every wake traceable to one predicate a person can read.
 */
export const watchPredicate = z.object({
  all: z.array(watchClause).min(1).max(MAX_WATCH_CLAUSES),
});
export type WatchPredicate = z.infer<typeof watchPredicate>;

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
): boolean {
  const actual = readWatchField(observation, clause.field);
  switch (clause.op) {
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

/** Every clause, or no wake. */
export function evaluateWatch(
  predicate: WatchPredicate,
  observation: WatchObservation,
  previous: WatchObservation | null = null,
): boolean {
  return predicate.all.every((clause) => evaluateWatchClause(clause, observation, previous));
}
