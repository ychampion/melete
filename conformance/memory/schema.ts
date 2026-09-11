/**
 * The memory scenario DSL (E6).
 *
 * A scenario is a JSON file: a short sequence of things that happen to a fresh
 * memory space, and what a person should be able to ask afterwards. It is
 * deliberately small and declarative so that adding a case is writing a file
 * rather than writing a test, and so that the same file can be run twice: once
 * normally, and once with recall withheld.
 *
 * The eight families come from the memory experiment plan. Every family has at
 * least one scenario, and every scenario says whether it is supposed to need
 * memory at all.
 */
import { timestamp } from '@melete/contracts';
import { z } from 'zod';

export const FAMILIES = [
  'stable-personalization',
  'corrections-and-time',
  'continuing-work',
  'relationships',
  'source-authority',
  'forgetting-and-access',
  'low-value-memory',
  'procedure-transfer',
] as const;
export type Family = (typeof FAMILIES)[number];
export const family = z.enum(FAMILIES);

/** The process points W7's failure schedules already kill at. */
export const FAULT_PHASES = [
  'after-input',
  'after-claim',
  'after-proposal',
  'before-publication',
  'after-publication',
  'during-cleanup',
] as const;
export type FaultPhase = (typeof FAULT_PHASES)[number];

const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'a step name is a lower-case slug');
/** `main` is the scenario's own space; `other` is a second space it must never see into. */
const space = z.enum(['main', 'other']).default('main');
const instant = timestamp;

/**
 * What the scripted extractor will propose for a source. The runner builds the
 * proposal from this: the key, the value, and the exact span in the source text
 * the value is read out of. Nothing is inferred, so a scenario that changes
 * still fails for a reason a reader can name.
 */
export const scriptedClaim = z.strictObject({
  key: z.string().min(1).max(200),
  content: z.string().min(1).max(4000),
  kind: z
    .enum([
      'user_statement',
      'document_assertion',
      'checked_fact',
      'inferred',
      'preference',
      'exception',
    ])
    .default('user_statement'),
  factual_status: z.enum(['attributed', 'checked', 'tentative']).default('attributed'),
  /** The verbatim substring of this source's text the claim rests on. Defaults to all of it. */
  quote: z.string().min(1).max(4000).optional(),
  /**
   * `self` cites the evidence this extraction was given. `previous_source` cites
   * the message before it, which is the "attach it to a convenient nearby
   * message" failure the service must refuse.
   */
  cite: z.enum(['self', 'previous_source']).default('self'),
  valid_from: instant.optional(),
  valid_until: instant.nullable().default(null),
  /** True when the service is supposed to reject this proposal and record a reason. */
  expect_rejected: z.boolean().default(false),
});
export type ScriptedClaim = z.infer<typeof scriptedClaim>;

const evidenceFields = {
  name: slug,
  space,
  event_time: instant,
  text: z.string().min(1).max(20000),
  time_zone: z.string().min(1).max(120).optional(),
  claim: scriptedClaim.optional(),
};

/** Something the owner said, in their own words, in this space. */
export const sayStep = z.strictObject({
  step: z.literal('say'),
  ...evidenceFields,
});
/** A document or message that arrives later and carries its own event time. */
export const importStep = z.strictObject({
  step: z.literal('import'),
  source_type: z.enum(['message', 'document', 'assistant']).default('document'),
  author: z.enum(['owner', 'external']).default('external'),
  ...evidenceFields,
});
/** A structured observation from a connected account. Tier 0 reads it; no model is called. */
export const observeStep = z.strictObject({
  step: z.literal('observe'),
  name: slug,
  space,
  event_time: instant,
  time_zone: z.string().min(1).max(120).optional(),
  observation: z.record(z.string(), z.unknown()),
  /** The keys Tier 0 is expected to produce from it. */
  expect_keys: z.array(z.string()).default([]),
});
/** An explicit owner correction, which takes effect immediately and is protected. */
export const correctStep = z.strictObject({
  step: z.literal('correct'),
  name: slug,
  space,
  key: z.string().min(1).max(200),
  text: z.string().min(1).max(4000),
  content: z.string().min(1).max(4000),
  valid_from: instant,
  valid_until: instant.nullable().default(null),
});
export const forgetStep = z.strictObject({
  step: z.literal('forget'),
  space,
  key: z.string().min(1).max(200).optional(),
  all: z.boolean().default(false),
});
/** Revoke one imported source. Its claims leave retrieval with it. */
export const revokeStep = z.strictObject({
  step: z.literal('revoke'),
  space,
  source: slug,
});
export const snapshotStep = z.strictObject({
  step: z.literal('snapshot'),
  name: slug,
});
/**
 * Kill a real process at one of W7's named write-protocol boundaries. `resume`
 * re-claims the interrupted work afterwards, which is what proves the next
 * attempt uses authentic state without repeating the effect.
 */
export const killAtStep = z.strictObject({
  step: z.literal('kill_at'),
  space,
  phase: z.enum(FAULT_PHASES),
  resume: z.boolean().default(true),
});
/** Restore the database to a named snapshot, then replay the retained journal. */
export const restoreFromStep = z.strictObject({
  step: z.literal('restore_from'),
  snapshot: slug,
});

export const askExpectation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('answer'),
    content: z.string().min(1).max(4000),
    /** The trust class the answer must carry, when the family is about attribution. */
    origin_trust: z
      .enum(['owner', 'verified_connector', 'external_content', 'inferred'])
      .optional(),
    /** Other keys the same recall must also have delivered, for a join. */
    also_delivered: z.array(z.string()).default([]),
    /** Keys this recall must not have delivered: irrelevant memory stays out. */
    not_delivered: z.array(z.string()).default([]),
    /** True when the answer must carry the date it was true, not just the value. */
    dated: z.boolean().default(false),
  }),
  z.strictObject({ kind: z.literal('disputed'), content: z.string().min(1).max(4000).optional() }),
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('absent') }),
]);
export type AskExpectation = z.infer<typeof askExpectation>;

export const askStep = z.strictObject({
  step: z.literal('ask'),
  name: slug,
  space,
  /** The words the reader would use. It is a real lexical query, not a key lookup. */
  query: z.string().min(1).max(2000),
  /** The key the answer must come from. The scripted assistant may use nothing else. */
  key: z.string().min(1).max(200),
  mode: z.enum(['current', 'historical']).default('current'),
  at: instant.optional(),
  expect: askExpectation,
});
/** How many owner questions should be queued at this point, in total. */
export const expectQuestionStep = z.strictObject({
  step: z.literal('expect_question'),
  space,
  count: z.number().int().nonnegative(),
});
/**
 * Replaying the last completed extraction must be a no-op: the same work
 * commits as a duplicate, the key keeps one active head, and the support behind
 * it does not inflate.
 */
export const expectNoEffectDuplicateStep = z.strictObject({
  step: z.literal('expect_no_effect_duplicate'),
  space,
  key: z.string().min(1).max(200).optional(),
  max_revisions: z.number().int().positive().default(1),
  max_sources: z.number().int().positive().optional(),
});

export const step = z.discriminatedUnion('step', [
  sayStep,
  importStep,
  observeStep,
  correctStep,
  forgetStep,
  revokeStep,
  snapshotStep,
  killAtStep,
  restoreFromStep,
  askStep,
  expectQuestionStep,
  expectNoEffectDuplicateStep,
]);
export type Step = z.infer<typeof step>;
export type AskStep = z.infer<typeof askStep>;

export const scenario = z.strictObject({
  id: slug,
  family,
  title: z.string().min(1).max(200),
  /** One sentence: the perturbation, and what success looks like from outside. */
  narrative: z.string().min(1).max(600),
  /**
   * True when the scenario is supposed to be impossible without memory. The
   * runner then runs it a second time with recall withheld and fails the suite
   * if it still passes.
   */
  memory_required: z.boolean(),
  /** `todo` scenarios are listed with their assertion and not executed. */
  status: z.enum(['run', 'todo']).default('run'),
  todo_reason: z.string().max(600).optional(),
  time_zone: z.string().min(1).max(120).default('UTC'),
  steps: z.array(step).min(1).max(60),
});
export type Scenario = z.infer<typeof scenario>;

export function parseScenario(raw: unknown, path: string): Scenario {
  const result = scenario.safeParse(raw);
  if (!result.success) throw new Error(`${path}: ${result.error.issues[0]?.message ?? 'invalid'}`);
  return result.data;
}
