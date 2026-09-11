/**
 * A scenario is a script a job plays. It is data, not code, so adding a case to
 * the mock is a JSON file rather than a branch: `scenarios/*.json`.
 *
 * The steps describe what a runtime would do, never what the job state should
 * become. State is always the contract's `transition` function answering an
 * authorized input, so the mock cannot drift from the real machine by writing a
 * state it likes better.
 */
import { EVENT_TYPES, effectClass } from '@melete/contracts';
import { z } from 'zod';

const label = z.string().min(1).max(60);

export const scenarioStep = z.discriminatedUnion('step', [
  /** Streamed assistant text. Transient: not replayed after a reconnect. */
  z.object({
    step: z.literal('text'),
    delay_ms: z.number().int().nonnegative().default(400),
    text: z.string().min(1),
  }),
  /** A tool call and its result, both durable. */
  z.object({
    step: z.literal('tool'),
    delay_ms: z.number().int().nonnegative().default(300),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    result: z.record(z.string(), z.unknown()).default({}),
  }),
  /** The runtime proposes an external effect. The broker canonicalises it. */
  z.object({
    step: z.literal('propose'),
    delay_ms: z.number().int().nonnegative().default(400),
    ref: label,
    kind: z.string().min(1),
    connection: z.string().min(1),
    effect_class: effectClass,
    payload: z.record(z.string(), z.unknown()),
  }),
  /** The job parks until a person decides. Denial jumps to `on_denied`. */
  z.object({
    step: z.literal('await_approval'),
    delay_ms: z.number().int().nonnegative().default(200),
    ref: label,
    on_denied: label.nullable().default(null),
  }),
  /** The job parks on one precise question. */
  z.object({
    step: z.literal('await_input'),
    delay_ms: z.number().int().nonnegative().default(200),
    question: z.string().min(1),
  }),
  /** The connector is called. `unknown` is a real outcome and is never retried. */
  z.object({
    step: z.literal('dispatch'),
    delay_ms: z.number().int().nonnegative().default(500),
    ref: label,
    outcome: z.enum(['succeeded', 'failed', 'unknown']),
    external_ref: z.string().nullable().default(null),
    reason: z.string().default(''),
    detail: z.record(z.string(), z.unknown()).default({}),
  }),
  /** A plain notice in the feed, for the inbox. */
  z.object({
    step: z.literal('notice'),
    delay_ms: z.number().int().nonnegative().default(200),
    level: z.enum(['info', 'attention', 'problem']),
    title: z.string().min(1),
    body: z.string().default(''),
  }),
  /** The attempt claims completion. The state machine still has the last word. */
  z.object({
    step: z.literal('complete'),
    delay_ms: z.number().int().nonnegative().default(300),
    answer: z.string().default(''),
  }),
  z.object({
    step: z.literal('fail'),
    delay_ms: z.number().int().nonnegative().default(300),
    reason: z.string().min(1),
    retryable: z.boolean().default(false),
  }),
]);
export type ScenarioStep = z.infer<typeof scenarioStep>;

export const scenario = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  /** Shown in the reference app so a person can pick a scenario on purpose. */
  summary: z.string().min(1),
  /** Lowercased substrings matched against the job title and objective. */
  match: z.array(z.string().min(1)).default([]),
  /** Chosen when nothing matched. Exactly one scenario may claim this. */
  fallback: z.boolean().default(false),
  provider: z.string().min(1).default('test'),
  model: z.string().min(1).default('scripted-1'),
  runtime_version: z.string().min(1).default('mock-0.1'),
  /** Labels a step can jump to, keyed by label, filled in by the loader. */
  steps: z.array(scenarioStep.and(z.object({ label: label.optional() }))).min(1),
});
export type Scenario = z.infer<typeof scenario>;

export const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Index of label to step position, checked once so a jump cannot dangle. */
export function labelIndex(script: Scenario): Map<string, number> {
  const index = new Map<string, number>();
  script.steps.forEach((step, position) => {
    if (!step.label) return;
    if (index.has(step.label))
      throw new Error(`scenario ${script.id}: duplicate label ${step.label}`);
    index.set(step.label, position);
  });
  for (const step of script.steps) {
    if (step.step === 'await_approval' && step.on_denied && !index.has(step.on_denied)) {
      throw new Error(`scenario ${script.id}: on_denied points at missing label ${step.on_denied}`);
    }
  }
  return index;
}

export function parseScenario(raw: unknown): Scenario {
  const parsed = scenario.parse(raw);
  labelIndex(parsed);
  return parsed;
}

/** Pick the scenario a new job should play from what the owner asked for. */
export function chooseScenario(scenarios: Scenario[], text: string): Scenario {
  const haystack = text.toLowerCase();
  const matched = scenarios.find((candidate) =>
    candidate.match.some((needle) => haystack.includes(needle.toLowerCase())),
  );
  if (matched) return matched;
  const fallback = scenarios.find((candidate) => candidate.fallback);
  if (fallback) return fallback;
  const first = scenarios[0];
  if (!first) throw new Error('no scenarios are loaded');
  return first;
}
