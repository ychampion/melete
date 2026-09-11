/**
 * Test-only injection points for the memory conformance runner (E6).
 *
 * The runner's value depends on it being able to go red. A suite nobody has
 * ever seen fail is a suite nobody has reason to believe, so
 * `conformance/memory/breaks.test.ts` turns three of the rules off on purpose
 * through the hooks below, asserts that the scenarios which rest on them fail,
 * and turns them back on.
 *
 * Every field here is undefined in production. The guarded branch is never
 * taken, and nothing in a request body, model response, queue payload or
 * database row can set one: the only way in is a direct in-process call to
 * `setMemorySeams` from a test in the same process, and `resetMemorySeams`
 * puts the defaults back.
 */
import type { KeyDecision } from './contradictions.ts';

export type MemorySeams = {
  /**
   * Rewrite the precedence table's verdict for one keyed publication. The break
   * that makes a late import win is exactly this hook returning `publish` where
   * the table said `historical`.
   */
  keyedHeadDecision?: (decision: KeyDecision) => KeyDecision;
  /**
   * Accept a span that does not belong to the evidence this invocation was
   * given, which is the "cite a convenient nearby message" failure mode.
   */
  acceptForeignCitation?: boolean;
  /** Return from restore without replaying the independently retained journal. */
  skipRestrictionReplay?: boolean;
};

const seams: MemorySeams = {};

/** Read the hooks. Production reads an empty object on every call. */
export const memorySeams = (): Readonly<MemorySeams> => seams;

export function setMemorySeams(next: MemorySeams): void {
  Object.assign(seams, next);
}

export function resetMemorySeams(): void {
  for (const field of Object.keys(seams) as (keyof MemorySeams)[]) delete seams[field];
}
