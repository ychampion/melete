/**
 * How long the engine may stay quiet, and what it is told when it has been
 * quiet too long or has stopped without a word for the person.
 *
 * A turn the person is watching must never sit on "working" with nothing
 * happening, and must never end without an answer. Every step has a deadline
 * (the broker's for its tool, the gateway's for the model), so silence well
 * past the deadline of the step the engine is on means it is stuck. It is then
 * asked once, without the person seeing, to report what it has; if it stays
 * stuck, the turn ends with a short note that says so.
 */
import { BROKER_TIMEOUT_MS, type ToolSpec } from '@melete/contracts';
import { DELEGATION_LIMITS } from './engine-config.ts';

/**
 * The gateway ends a model call that has sent nothing for this long, so no
 * step without a tool in flight is quiet for longer, bar the engine's retry.
 */
export const MODEL_SILENCE_MS = 60_000;

/** Added to the longest a step may take before the engine counts as stuck. */
export const STALL_MARGIN_MS = 120_000;

/** Past the broker's answer for a tool, as the plugin waits (`ANSWER_SLACK_SECONDS`). */
const ANSWER_SLACK_MS = 30_000;
/** The broker's longest dispatch for one call (`MAX_DISPATCH_BUDGET_MS`). */
const MAX_DISPATCH_MS = 15 * 60_000;
/** A sandbox command at its longest, with the sandbox's setup (`command_wait_seconds`). */
const COMMAND_MS = (600 + 180 + 30) * 1000;
/** A measured try: its first command, then its variants (`RUN_TRY_WAIT_SECONDS`). */
const TRY_MS = (2 * (600 + 180) + 30) * 1000;

/** The longest one call of this tool may take before an answer is owed. */
export function stepDeadlineMs(tool: string, catalog: readonly ToolSpec[]): number {
  if (tool === 'terminal' || tool === 'terminal.run') return COMMAND_MS;
  if (tool === 'run.try') return TRY_MS;
  if (tool === 'delegate_task')
    return DELEGATION_LIMITS.child_timeout_seconds * 1000 + ANSWER_SLACK_MS;
  const spec = catalog.find((entry) => entry.name === tool);
  // A call that names its own timeout may take up to the broker's limit.
  const own =
    spec?.input_schema &&
    typeof spec.input_schema === 'object' &&
    'timeout_ms' in ((spec.input_schema as { properties?: object }).properties ?? {});
  const deadline = own
    ? MAX_DISPATCH_MS
    : Math.min(Math.max(BROKER_TIMEOUT_MS, spec?.deadline_ms ?? 0), MAX_DISPATCH_MS);
  return deadline + ANSWER_SLACK_MS;
}

/** How long the engine may send nothing while these tools are in flight. */
export function quietAllowanceMs(open: readonly string[], catalog: readonly ToolSpec[]): number {
  const step = open.length
    ? Math.max(...open.map((tool) => stepDeadlineMs(tool, catalog)))
    : MODEL_SILENCE_MS;
  return step + STALL_MARGIN_MS;
}

const minutes = (ms: number): string => {
  const whole = Math.max(1, Math.round(ms / 60_000));
  return whole === 1 ? '1 minute' : `${whole} minutes`;
};

/** What a stuck engine is told, in a fresh run of the same attempt. */
export const stalledContinuation = (silentMs: number): string =>
  `Nothing came back from your last step for ${minutes(silentMs)}, so it was stopped. ` +
  'Do not repeat it. Tell the person now, in a few sentences, what you have found or done so ' +
  'far and what is left. Carry on only if you can finish quickly another way.';

/** How a turn ends when the engine stays stuck after being asked to report. */
export const stalledNote = (silentMs: number, elapsedMs: number): string =>
  `I stopped here: my work stopped responding, and nothing came back for ${minutes(silentMs)}. ` +
  `I had been working on this for ${minutes(elapsedMs)}. Nothing more is running. ` +
  'Send a message and I will pick it up from here.';

/** What an engine that ended on tool calls, with no word for the person, is told. */
export const DELIVER_CONTINUATION =
  'You stopped without telling the person anything. Write your reply to them now: what you ' +
  'found or did, with links to the pages it came from, and anything still open. Do not start ' +
  'new work.';
