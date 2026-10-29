/**
 * Notes for one model family, added to the agent's instructions when the
 * connected model belongs to it. A family is matched on the model id alone, so
 * the same model reached through any provider gets the same notes.
 *
 * The entries below are plain data, kept apart from the code that reads them,
 * so they can be tuned from measurements without touching anything else. Keep
 * each `text` short: a test holds it under `MODEL_GUIDANCE_TOKEN_LIMIT`.
 */

export type ModelGuidance = {
  /** A short name for the family, for logs and tests. */
  family: string;
  /** Matched against the model id, ignoring case and the provider's prefix. */
  match: RegExp;
  /** Markdown added after the rest of the instructions, under its own heading. */
  text: string;
  /**
   * Extra chat template arguments sent with every chat completions call to this
   * family, such as a reasoning switch. Unset sends nothing. A request that
   * already names `chat_template_kwargs` keeps its own.
   */
  chat_template_kwargs?: Readonly<Record<string, unknown>>;
};

/** The most a family's `text` may cost, in estimated tokens (characters / 4). */
export const MODEL_GUIDANCE_TOKEN_LIMIT = 250;

export const MODEL_GUIDANCE: readonly ModelGuidance[] = [
  {
    family: 'nemotron',
    match: /nemotron/i,
    text: [
      "- Give a time as the person's local wall time, with no Z and no offset, unless the tool asks for UTC.",
      '- Search with one or two plain keywords at a time. Try another keyword before you conclude nothing is there.',
      '- Open and read the specific item you were asked about before you judge it.',
      '- Copy placeholders such as ⟦ACCOUNT_1⟧ exactly, brackets included, and never invent one.',
      '- When an approval arrives, carry out the approved step in that same turn.',
      '- Say an action is done only when its tool result says it succeeded.',
      "- When you need the person's answer, ask with ask_person (board.ask in a room) and end your turn instead of ending on a question. A question for one person in a room goes to them alone.",
      '- Keep the final answer short and plain, with no reasoning in it.',
    ].join('\n'),
    // NVIDIA's switch for these models is `{ enable_thinking: false }` (or
    // `{ enable_thinking: true, low_effort: true }` for shorter reasoning).
    // Left unset: reasoning stays at the provider's default.
  },
];

/** The family a model id belongs to, or undefined for a model with no notes. */
export function modelGuidance(model: string): ModelGuidance | undefined {
  return MODEL_GUIDANCE.find((entry) => entry.match.test(model));
}
