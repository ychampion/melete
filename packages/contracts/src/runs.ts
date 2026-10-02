/**
 * Long work. A run is a goal an assistant keeps working on across many bounded
 * attempts, its shifts, for as long as the work takes: hours, days or weeks.
 * The service decides between shifts, without a model call, whether the work
 * goes on now, sleeps until a time, waits for its helpers, or stops to ask.
 *
 * Everything a run learns goes into its record: the plan, findings,
 * experiments with their measured results, decisions, progress reports and the
 * handoff at the end of each shift. The record is append-only, so it can be
 * read back, exported and checked later.
 */
import { z } from 'zod';
import { timestamp } from './common.ts';
import type { ToolSpec } from './runtime.ts';

export const RUN_KINDS = ['run', 'run_step'] as const;
export const isRunKind = (kind: string): boolean => (RUN_KINDS as readonly string[]).includes(kind);

export const RUN_ENTRY_KINDS = [
  'plan',
  'note',
  'finding',
  'decision',
  'experiment',
  'report',
  'checkpoint',
  'step_started',
  'step_finished',
  /** A result offered while a separate check confirms it. */
  'proposed',
  /** What the check of a proposed result found. */
  'check',
  'finished',
] as const;
export const runEntryKind = z.enum(RUN_ENTRY_KINDS);
export type RunEntryKind = z.infer<typeof runEntryKind>;

/** The kinds a model writes with `run.log`; the rest are written by the service or other tools. */
export const RUN_LOG_KINDS = [
  'plan',
  'note',
  'finding',
  'decision',
  'experiment',
  'report',
] as const;

export const RUN_TITLE_LIMIT = 200;
export const RUN_BODY_LIMIT = 8000;
/** Active helpers one run may have at once. */
export const RUN_ACTIVE_STEP_LIMIT = 6;
/** Shifts in a row that recorded nothing and did nothing before the run stops to ask. */
export const RUN_IDLE_SHIFT_LIMIT = 3;
/** Checks that may find gaps in a result before it is given anyway, with the gaps named. */
export const RUN_CHECK_LIMIT = 2;

export const runMetric = z.object({
  name: z.string().min(1).max(80),
  /** Which way is better. */
  direction: z.enum(['higher', 'lower']),
});
export type RunMetric = z.infer<typeof runMetric>;

/**
 * An optional overall limit. A run has none unless the person sets one; each
 * shift still has its own ceilings, which only stop a runaway loop.
 */
export const runLimit = z
  .object({
    max_hours: z
      .number()
      .positive()
      .max(24 * 365)
      .optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_shifts: z.number().int().positive().optional(),
  })
  .strict();
export type RunLimit = z.infer<typeof runLimit>;

const title = z.string().trim().min(1).max(RUN_TITLE_LIMIT);
const body = z.string().max(RUN_BODY_LIMIT);

export const runStartInput = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    title: title.optional(),
    done_when: z.string().trim().max(1000).optional(),
    metric: runMetric.optional(),
  })
  .strict();
export type RunStartInput = z.infer<typeof runStartInput>;

export const runLogInput = z
  .object({
    kind: z.enum(RUN_LOG_KINDS),
    title,
    body: body.optional(),
    /** Experiments: what was tried and why. */
    hypothesis: z.string().max(2000).optional(),
    /** Experiments: the measured value. */
    value: z.number().finite().optional(),
    /** Experiments: kept as the new approach, discarded, or the attempt itself failed. */
    outcome: z.enum(['kept', 'discarded', 'failed']).optional(),
    /** Experiments: the ids of the actions whose output shows the value. */
    evidence: z.array(z.string().max(64)).max(10).optional(),
    /** An approach that did not work, so later shifts do not try it again. */
    dead_end: z.boolean().optional(),
  })
  .strict();
export type RunLogInput = z.infer<typeof runLogInput>;

export const runDelegateInput = z
  .object({
    task: z.string().trim().min(1).max(4000),
    title: title.optional(),
    /** An assistant's name or role; the run's own assistant when left out. */
    assistant: z.string().trim().max(120).optional(),
  })
  .strict();
export type RunDelegateInput = z.infer<typeof runDelegateInput>;

/** When the next shift starts: now, once the helpers are done, or at a time. */
export const runNext = z.union([z.literal('now'), z.literal('when_helpers_finish'), timestamp]);

export const runCheckpointInput = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    next: z.string().trim().min(1).max(2000),
    next_shift: runNext.optional(),
  })
  .strict();
export type RunCheckpointInput = z.infer<typeof runCheckpointInput>;

export const runFinishInput = z
  .object({
    summary: z.string().trim().min(1).max(RUN_BODY_LIMIT),
    /** The ids of the actions the result rests on. */
    evidence: z.array(z.string().max(64)).max(10).optional(),
    /** Checking a result: whether it holds, or the specific gaps found. */
    verdict: z.enum(['passes', 'gaps']).optional(),
    gaps: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
  })
  .strict();
export type RunFinishInput = z.infer<typeof runFinishInput>;

// ---------------------------------------------------------------------------
// Tool specs. Schemas stay small: they share the attempt's core catalog.

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const RUN_START_TOOL: ToolSpec = {
  name: 'run.start',
  description:
    'Start work that continues in the background for hours or days and reports back. Use it whenever the person asks for something to be done in the background, or the work is too big for one reply: research across many sources, testing ideas, anything to keep at until done.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: obj(
    {
      goal: { type: 'string' },
      title: { type: 'string' },
      done_when: { type: 'string', description: 'How to tell it is finished.' },
      metric: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          direction: { type: 'string', enum: ['higher', 'lower'] },
        },
        required: ['name', 'direction'],
      },
    },
    ['goal'],
  ),
};

export const RUN_LOG_TOOL: ToolSpec = {
  name: 'run.log',
  description:
    "Add to this work's record: the plan, a finding, a decision, an experiment and its measured value, or a progress report for the person.",
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: obj(
    {
      kind: { type: 'string', enum: [...RUN_LOG_KINDS] },
      title: { type: 'string' },
      body: { type: 'string' },
      hypothesis: { type: 'string' },
      value: { type: 'number' },
      outcome: { type: 'string', enum: ['kept', 'discarded', 'failed'] },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Action ids whose output shows the value.',
      },
      dead_end: {
        type: 'boolean',
        description: 'This approach did not work; later shifts should not try it again.',
      },
    },
    ['kind', 'title'],
  ),
};

export const RUN_DELEGATE_TOOL: ToolSpec = {
  name: 'run.delegate',
  description:
    'Hand part of this work to a helper that works on it in parallel and reports back here.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: obj(
    {
      task: { type: 'string' },
      title: { type: 'string' },
      assistant: { type: 'string', description: 'An assistant name or role.' },
    },
    ['task'],
  ),
};

export const RUN_CHECKPOINT_TOOL: ToolSpec = {
  name: 'run.checkpoint',
  description:
    'End this shift: say what was done and what comes next. The next shift starts from this.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: obj(
    {
      summary: { type: 'string' },
      next: { type: 'string' },
      next_shift: {
        type: 'string',
        description: '"now" (default), "when_helpers_finish", or a future UTC time.',
      },
    },
    ['summary', 'next'],
  ),
};

export const RUN_FINISH_TOOL: ToolSpec = {
  name: 'run.finish',
  description: 'The work is done: give the result. Ends the work.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: obj(
    {
      summary: { type: 'string' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Action ids the result rests on.',
      },
      verdict: {
        type: 'string',
        enum: ['passes', 'gaps'],
        description: 'Only when checking a result.',
      },
      gaps: { type: 'array', items: { type: 'string' }, description: 'With verdict "gaps".' },
    },
    ['summary'],
  ),
};

export const RUN_TOOLS = [
  RUN_START_TOOL,
  RUN_LOG_TOOL,
  RUN_DELEGATE_TOOL,
  RUN_CHECKPOINT_TOOL,
  RUN_FINISH_TOOL,
] as const;
export const RUN_TOOL_NAMES: readonly string[] = RUN_TOOLS.map((tool) => tool.name);

/** The run tools an attempt of this kind of job is offered. */
export function runScopes(kind: string): string[] {
  if (kind === 'chat') return ['run.start'];
  if (kind === 'run') return ['run.log', 'run.delegate', 'run.checkpoint', 'run.finish'];
  if (kind === 'run_step') return ['run.log', 'run.checkpoint', 'run.finish'];
  return [];
}

// ---------------------------------------------------------------------------
// What a person and a client read.

export const runStatus = z.enum(['working', 'waiting', 'needs_you', 'done', 'stopped', 'failed']);
export type RunStatus = z.infer<typeof runStatus>;

export const runEntry = z.object({
  id: z.string(),
  kind: runEntryKind,
  title: z.string(),
  body: z.string(),
  /** Which helper wrote it, when one did. */
  step_id: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  created_at: timestamp,
});
export type RunEntry = z.infer<typeof runEntry>;

export const runExperimentView = z.object({
  id: z.string(),
  title: z.string(),
  value: z.number().nullable(),
  outcome: z.enum(['kept', 'discarded', 'failed']).nullable(),
  /** The value appears in the output of an action the experiment cited. */
  checked: z.boolean(),
  created_at: timestamp,
});

/**
 * Whether the result was confirmed by a separate check before the work was
 * called done: under way, passed, gaps sent back to the work, or given
 * anyway with what could not be confirmed.
 */
export const runCheckView = z.object({
  enabled: z.boolean(),
  state: z.enum(['checking', 'passed', 'gaps', 'not_confirmed']).nullable(),
  gaps: z.array(z.string()),
});

export const runStepView = z.object({
  id: z.string(),
  title: z.string(),
  status: runStatus,
  result: z.string().nullable(),
});

export const runView = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  done_when: z.string().nullable(),
  status: runStatus,
  /** One plain line on where things stand. */
  status_line: z.string(),
  conversation_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  started_at: timestamp,
  finished_at: timestamp.nullable(),
  next_shift_at: timestamp.nullable(),
  shifts: z.number().int().nonnegative(),
  metric: runMetric.nullable(),
  limit: runLimit.nullable(),
  plan: z.string().nullable(),
  latest_report: z
    .object({ title: z.string(), body: z.string(), created_at: timestamp })
    .nullable(),
  next: z.string().nullable(),
  result: z.string().nullable(),
  experiments: z.object({
    count: z.number().int().nonnegative(),
    best: runExperimentView.nullable(),
    recent: z.array(runExperimentView),
  }),
  findings: z.number().int().nonnegative(),
  steps: z.array(runStepView),
  question: z.string().nullable(),
  check: runCheckView,
});
export type RunView = z.infer<typeof runView>;

export const runResponse = z.object({ run: runView });
export const runListResponse = z.object({ runs: z.array(runView) });
export const runListQuery = z.object({ conversation_id: z.string().optional() });
export const runRecordQuery = z.object({ after: z.string().regex(/^\d+$/).optional() });
export const runExportResponse = z.object({ markdown: z.string() });
export const runRecordResponse = z.object({
  entries: z.array(runEntry),
  next_cursor: z.string().nullable(),
});

export const runCreateRequest = runStartInput.extend({
  agent_id: z.string().optional(),
  limit: runLimit.optional(),
  /** Have a separate check confirm the result before it is called done. On by default. */
  check_result: z.boolean().optional(),
});
export const runMessageRequest = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
/** A limit (null clears it) and whether results are checked; what is left out stays as it is. */
export const runLimitRequest = z
  .object({ limit: runLimit.nullable().optional(), check_result: z.boolean().optional() })
  .strict();
