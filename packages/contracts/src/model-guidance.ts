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
      '- Call tools with the exact argument names and JSON types their schema gives. Take one step at a time: make a call, read its result, then decide the next step. Answer only once you have read the results you need.',
      '- Never say an action is done unless its tool result says it succeeded. If it failed or needs approval, say that plainly.',
      "- When you need the person's answer to go on, ask with ask_person (board.ask in a room) and end your turn, rather than ending your reply with a question.",
      '- A question or note for one person in a room goes to that person alone, with board.ask or board.note, never in the reply everyone sees.',
      '- Keep the final answer short and plain. Give the result, with no reasoning or plans in it.',
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
