/**
 * The agent editor's draft against the saved agent. The screen re-renders on
 * every background refresh, so the editor must tell a changed saved agent from
 * a copy of the same one, and must never throw away what the person typed.
 */
import type { AgentInput } from '../experience/types.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A stable identity for what the editor starts from: equal agents give the
 * same key however many times they are rebuilt.
 */
export const draftKey = (selected: string | null, input: AgentInput | null): string | null =>
  input === null ? null : JSON.stringify([selected, input]);

/**
 * The draft after the saved agent moved from `previous` to `next`. A field the
 * person has not touched follows the saved agent; a field they edited keeps
 * their edit.
 */
export function followSaved(draft: AgentInput, previous: AgentInput, next: AgentInput): AgentInput {
  const merged: Record<string, unknown> = { ...draft };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const field = key as keyof AgentInput;
    if (!same(draft[field], previous[field])) continue;
    if (next[field] === undefined) delete merged[key];
    else merged[key] = next[field];
  }
  return merged as AgentInput;
}
