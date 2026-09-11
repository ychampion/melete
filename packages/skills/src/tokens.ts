/**
 * A token estimate, not a tokenizer. Four characters to a token is close enough
 * for English prose and costs nothing, and the point of the cap is to keep a
 * skill short enough to read rather than to bill for it exactly.
 *
 * Every tokenizer we might use disagrees with every other one, so a skill is
 * written well inside its budget and the estimate only has to catch a file that
 * has grown into a document.
 */
export const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** What the identity file is allowed to cost, since it loads on every attempt. */
export const IDENTITY_MAX_TOKENS = 250;
