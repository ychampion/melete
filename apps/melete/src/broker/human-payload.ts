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
 * The pass is for words the model wrote, never for words a person wrote. The
 * broker applies it only to a model's own proposal (never to an owner command:
 * a draft card's send, a message another assistant asked to send, an undo),
 * and a line whose dash is in text the person typed in the conversation ("send
 * exactly: …", a pasted note) keeps that line as they typed it.
 *
 * Only the tools named here are changed, and only their written fields. Any
 * other tool's payload, and every address, id and attachment, is left as the
 * agent wrote it.
 */
import { humanText, type JsonObject } from '@melete/contracts';
import { roomAuthorityOf } from '../rooms/approvals.ts';
import type { Query } from './records.ts';

/** How many of the conversation's latest messages are read for the person's own words. */
const SAID_LIMIT = 200;

/**
 * What people typed in the conversation a job belongs to: its own messages,
 * its parent conversation's and, for a room's work, the room request's. An
 * option the person picked is the assistant's words, so it is left out.
 */
export async function typedInConversation(tx: Query, jobId: string): Promise<string[]> {
  const [row] = await tx`select experience_parent_id from job where id = ${jobId}`;
  const room = await roomAuthorityOf(tx, jobId);
  const jobs = [
    ...new Set(
      [jobId, row?.experience_parent_id, room?.requestJobId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  const rows = await tx`select payload->>'text' as text from event
    where job_id = any(${jobs}) and type = 'notice'
      and payload->>'kind' = 'user_message' and payload->'chosen' is null
    order by seq desc limit ${SAID_LIMIT}`;
  return rows.map((entry) => String(entry.text ?? '')).filter(Boolean);
}

/** The fields of each outgoing-message tool that a person reads. */
const WRITTEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'email.draft': ['subject', 'body'],
  'email.send': ['subject', 'body'],
  'sms.send': ['body'],
};

/** A dash the pass may change: a dash character, or a spaced double hyphen. */
const DASH = /[—–―]+|(?<=\s)-{2,3}(?=\s|$)/g;
/** How much of a line around a dash must match what the person typed. */
const AROUND = 12;

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Whether a dash in `line` sits in words the person typed, as they typed them. */
function typedByPerson(line: string, said: readonly string[]): boolean {
  for (const dash of line.matchAll(DASH)) {
    const at = dash.index ?? 0;
    const words = flat(
      line.slice(Math.max(0, at - AROUND), Math.min(line.length, at + dash[0].length + AROUND)),
    );
    if (words && said.some((text) => text.includes(words))) return true;
  }
  return false;
}

/** The pass on one written field, with the person's own lines as they typed them. */
function written(value: string, said: readonly string[]): string {
  const out = humanText(value, 'draft');
  if (out === value || said.length === 0) return out;
  const before = value.split('\n');
  const after = out.split('\n');
  // The draft pass changes no line break; if one ever did, keep the field as
  // it came rather than guess which line is whose.
  if (before.length !== after.length)
    return before.some((line) => typedByPerson(line, said)) ? value : out;
  return after
    .map((line, k) => {
      const original = before[k] as string;
      return line !== original && typedByPerson(original, said) ? original : line;
    })
    .join('\n');
}

/**
 * The payload of a model's outgoing message after the pass. `said` is what
 * people typed in the conversation; a line of theirs is left as it was.
 */
export function humanPayload(
  kind: string,
  payload: JsonObject,
  said: readonly string[] = [],
): JsonObject {
  const fields = WRITTEN_FIELDS[kind];
  if (!fields) return payload;
  const typed = said.map(flat).filter(Boolean);
  let changed: JsonObject | null = null;
  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== 'string') continue;
    const next = written(value, typed);
    if (next === value) continue;
    changed ??= { ...payload };
    changed[field] = next;
  }
  return changed ?? payload;
}
