/**
 * Words sent while a turn runs go into that turn, except words that open with
 * `@`: they name an agent (with or without a space after the `@`, and even a
 * name not found), so they wait for the turn to end and start their own.
 */
export const opensWithMention = (text: string): boolean => text.trimStart().startsWith('@');

/** Whether this message joins the running turn as it is sent. */
export const joinsRunningTurn = (text: string, working: boolean, files: number): boolean =>
  working && files === 0 && !opensWithMention(text);

/** Whether this message is held until the running turn ends, then sent as its own. */
export const waitsForTurn = (text: string, working: boolean): boolean =>
  working && opensWithMention(text);
