/**
 * Readers for the tool entries and conversation progress described in
 * docs/TOOL-CALLS.md. Both are additive fields a service may or may not send:
 * an action step can carry a `tool`, and a conversation can carry `progress`.
 * These read them without assuming either is there, so the interface draws
 * them when the data exists and draws nothing in their place when it does not.
 */

export type ToolKind =
  | 'connector'
  | 'web'
  | 'file'
  | 'artifact'
  | 'browser'
  | 'sandbox'
  | 'skill'
  | 'memory_recall'
  | 'memory_write'
  | 'memory_correct'
  | 'memory_forget'
  | 'model'
  | 'retry'
  | 'tool';

export type ToolSummary = {
  text: string;
  quote?: { text: string; from: string };
};

export type ToolEntry = {
  kind: ToolKind | string;
  title: string;
  status: 'running' | 'done' | 'failed' | 'needs_approval' | 'unknown' | string;
  input_summary: ToolSummary | null;
  output_summary: ToolSummary | null;
};

export type Progress = { steps_done: number; current: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function summaryOf(value: unknown): ToolSummary | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const quote = value.quote;
  return isRecord(quote) && typeof quote.text === 'string' && typeof quote.from === 'string'
    ? { text: value.text, quote: { text: quote.text, from: quote.from } }
    : { text: value.text };
}

/** The tool entry a finished trail step carries, when the service sends one. */
export function toolOf(step: unknown): ToolEntry | null {
  if (!isRecord(step)) return null;
  const tool = step.tool;
  if (!isRecord(tool) || typeof tool.title !== 'string' || typeof tool.kind !== 'string')
    return null;
  return {
    kind: tool.kind,
    title: tool.title,
    status: typeof tool.status === 'string' ? tool.status : 'done',
    input_summary: summaryOf(tool.input_summary),
    output_summary: summaryOf(tool.output_summary),
  };
}

/** A conversation's progress through its current turn, when the service sends it. */
export function progressOf(conversation: unknown): Progress | null {
  if (!isRecord(conversation)) return null;
  const progress = conversation.progress;
  if (!isRecord(progress) || typeof progress.steps_done !== 'number') return null;
  return {
    steps_done: Math.max(0, Math.floor(progress.steps_done)),
    current: typeof progress.current === 'string' ? progress.current : null,
  };
}
