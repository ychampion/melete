/**
 * Tool entries and conversation progress, as docs/TOOL-CALLS.md describes
 * them: a finished trail step can carry the `tool` entry it came from, the
 * stream sends each entry as `tool` items while it runs, and a conversation
 * carries `progress` while a turn is under way and for a day after. All three
 * are optional in the contract, so each reader answers null when the service
 * did not send one and nothing is drawn in its place.
 */
import type { Conversation, EventItem, TrailStep } from './types.ts';

export type ToolEntry = Extract<EventItem, { type: 'tool' }>['tool'];
export type ToolSummary = NonNullable<ToolEntry['input_summary']>;
export type Progress = NonNullable<Conversation['progress']>;

/** The tool entry a finished trail step carries, when the service sends one. */
export function toolOf(step: TrailStep): ToolEntry | null {
  return step.type === 'action' ? (step.tool ?? null) : null;
}

/** A conversation's progress through its current turn, when the service sends it. */
export function progressOf(conversation: Conversation): Progress | null {
  return conversation.progress ?? null;
}
