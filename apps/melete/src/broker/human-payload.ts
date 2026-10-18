/**
 * Words the agent writes for someone else, as a person would write them.
 *
 * A draft or message goes out under the person's name, so the plain-text pass
 * (`humanText` in the contracts package, in its draft mode) runs on its words
 * before the proposal is hashed. What the person approves, what a draft card
 * shows and what is sent are then the same text. Draft mode only fixes dashes:
 * a greeting, a sign-off, a closing line or bold text is the writer's choice in
 * a message, so it is kept.
 *
 * Only the tools named here are changed, and only their written fields. Any
 * other tool's payload, and every address, id and attachment, is left as the
 * agent wrote it.
 */
import { humanText, type JsonObject } from '@melete/contracts';

/** The fields of each outgoing-message tool that a person reads. */
const WRITTEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'email.draft': ['subject', 'body'],
  'email.send': ['subject', 'body'],
  'sms.send': ['body'],
};

export function humanPayload(kind: string, payload: JsonObject): JsonObject {
  const fields = WRITTEN_FIELDS[kind];
  if (!fields) return payload;
  let changed: JsonObject | null = null;
  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== 'string') continue;
    const written = humanText(value, 'draft');
    if (written === value) continue;
    changed ??= { ...payload };
    changed[field] = written;
  }
  return changed ?? payload;
}
