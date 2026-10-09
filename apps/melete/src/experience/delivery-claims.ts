/**
 * A reply that says a file is attached when none reached the person.
 *
 * A file the agent makes with a command stays on its computer until a files
 * tool puts it in the person's Files, which is what shows it under the reply
 * with Open and Download. A reply that says "attached" before that is untrue,
 * so the turn's answer gets one plain line saying the file is not there yet.
 */
import { savedFile } from '../artifact/shown.ts';

export const NOT_ATTACHED_NOTE =
  'No file is attached to this reply yet. Ask me and I’ll put it in your Files.';

/**
 * The agent saying it attached a file to this reply: "I've attached the list",
 * "The PDF is attached", "attached below". A file the person attached ("the
 * PDF you attached") is theirs, and other things called attached (a draft's
 * "the invoice is attached") are not claims about this reply.
 */
const CLAIMS_ATTACHED = [
  /\bI(?:'ve|’ve| have)? attached\b/i,
  /\b(?:file|pdf|document|spreadsheet|image|picture|chart|copy|list|report|it)s? (?:is|are|has been|have been) attached\b/i,
  /\battached (?:below|here|above|to this (?:reply|message))\b/i,
];

/** Work whose own text may say "attached": a message drafted or sent in the turn. */
const WRITES_MESSAGES = /^(?:email|mail|message|slack|chat)\./;

/** The tools whose success puts a file under the reply. */
const MAKES_A_FILE = new Set(['audio.synthesize', 'audio.transcribe', 'artifact.publish']);

type Done = { kind: string; receipt: unknown };

const delivers = (done: Done) =>
  MAKES_A_FILE.has(done.kind) ||
  ((done.kind === 'files.write' || done.kind === 'files.move') &&
    savedFile(done.kind, done.receipt) !== null);

/**
 * The answer as the person should read it, given the actions that succeeded in
 * its turn: unchanged, or with the note when it claims a file none of them made.
 */
export function withDeliveryNote(text: string, done: readonly Done[]): string {
  if (
    !CLAIMS_ATTACHED.some((claim) => claim.test(text)) ||
    text.includes(NOT_ATTACHED_NOTE) ||
    done.some((action) => delivers(action) || WRITES_MESSAGES.test(action.kind))
  )
    return text;
  return `${text.trimEnd()}\n\n${NOT_ATTACHED_NOTE}`;
}
