/**
 * The skills an attempt was given are chosen before any model speaks and go
 * into its instructions, so no tool call ever shows them. This is the one
 * entry that does: the conversation shows it as a tool call that names what
 * was followed. It carries names only, never a skill's instructions.
 *
 * The shape is the conversation's tool entry, written as the `tool_trace`
 * notice the conversation projects.
 */

export const SKILL_TRACE_KIND = 'tool_trace';

export type SkillTraceCall = {
  id: string;
  kind: 'skill';
  title: string;
  status: 'done';
  started_at: string;
  ended_at: string;
  input_summary: null;
  output_summary: { text: string };
  detail: null;
  parent: null;
};

const LEARNED = 'a way of working you showed me';

/** "research-with-sources" reads as "Research with sources". */
const plain = (name: string) => {
  if (name.startsWith('procedure:')) return LEARNED;
  const words = name.replace(/[-_]+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

export function skillTraceCall(
  attemptId: string,
  skills: readonly { readonly name: string; readonly body: string }[],
  at: Date,
): SkillTraceCall | null {
  if (skills.length === 0) return null;
  const names = skills.map((skill) => plain(skill.name));
  const [only] = names;
  const title =
    names.length === 1 && only
      ? only === LEARNED
        ? `Followed ${LEARNED}`
        : `Followed the skill: ${only}`
      : `Followed ${names.length} ways of working`;
  const when = at.toISOString();
  return {
    id: `skills:${attemptId}`,
    kind: 'skill',
    title: clip(title, 120),
    status: 'done',
    started_at: when,
    ended_at: when,
    input_summary: null,
    output_summary: {
      text: clip(
        names
          .map((name) => (name === LEARNED ? 'A way of working you showed me' : name))
          .join(', '),
        160,
      ),
    },
    detail: null,
    parent: null,
  };
}
