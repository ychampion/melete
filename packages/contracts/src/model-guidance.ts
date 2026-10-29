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
      '- Act when the request is clear and no one else has to decide. Ask only when a specific person must choose or approve: use ask_person (board.ask in a room) and end your turn, never a question in prose. A question for one person in a room goes to them alone.',
      "- In tool arguments, give times with the person's UTC offset for that date: the one shown with their local time under Now, which shifts with daylight saving. Use Z only for real UTC times. In replies, use local time.",
      '- Search one or two plain keywords at a time; try another before concluding nothing is there.',
      '- Read the item you were asked about before you judge it.',
      '- Copy any privacy placeholder exactly as it appears, brackets included; never invent one.',
      '- When an approval arrives, carry out the approved step in that same turn.',
      '- Say an action is done only when its tool result says it succeeded.',
      '- Keep the final answer short and plain, with no reasoning in it.',
    ].join('\n'),
    // NVIDIA's switch for these models is `{ enable_thinking: false }` (or
    // `{ enable_thinking: true, low_effort: true }` for shorter reasoning).
    // Left unset: reasoning stays at the provider's default.
  },
];

/**
 * Whether model guidance is on: `MELETE_MODEL_GUIDANCE=off` turns it off (the
 * notes and any chat template arguments), and anything else leaves it on. The
 * service reads it once, at start.
 */
export const modelGuidanceEnabled = (env: Record<string, string | undefined>): boolean =>
  env.MELETE_MODEL_GUIDANCE?.trim().toLowerCase() !== 'off';

/** The family a model id belongs to, or undefined for a model with no notes. */
export function modelGuidance(model: string): ModelGuidance | undefined {
  return MODEL_GUIDANCE.find((entry) => entry.match.test(model));
}
