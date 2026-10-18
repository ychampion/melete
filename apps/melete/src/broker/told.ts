/**
 * Whether the person said to send, in the request the agent is working on.
 *
 * A message the agent writes to someone stays a draft unless the person said
 * to send it. That is read here, from the person's own words in the turn the
 * attempt answers, and never from the model's account of them: a plain rule
 * over the text, the same at proposal, admission and dispatch.
 *
 * It counts when the person:
 * - asks for a send in so many words ("send it", "forward this to Sam",
 *   "can you send Bob the notes", "reply to the landlord", "email Ana that …");
 * - answers a short yes ("yes", "go ahead", "do it") right after the agent's
 *   last answer offered to send.
 *
 * It does not count when they ask only for a draft ("draft a reply to Bob"),
 * say not to send ("don't send it yet", "hold off"), or ask a question about
 * sending ("should I send it?", "did it send?").
 */
import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import type { Query } from './records.ts';

/** Words that, leading a clause, ask for a message to go to someone. */
const LEADING_VERB =
  /^(?:reply|respond|email|e-mail|text|message|mail|dm|write back)\b(?!\s+(?:from|is|was|thread|address|says|said|draft)\b)/;
/** Words that ask for a send anywhere in a clause. */
const SEND = /\bsend\b|(?<!(?:look|looking|going|moving|move|step|way|straight) )\bforward\b/;
/** A clause about the person's own doing: "I'll send it myself". */
const OWN_DOING = /^(?:i|i'll|i will|i'm|i am|i'd|we|we'll|we will|let me)\b/;
/** A clause that says not to send, or not yet. */
const HELD =
  /\b(?:don'?t|do not|dont|never|not yet|no need to|without|hold off|hold it|wait|before you|until i|stop)\b/;
/** A clause that asks only for a draft. */
const DRAFT_ONLY = /\b(?:draft|drafts|drafted|drafting)\b/;
/** Ways a person asks the agent to do something as a question. */
const REQUEST_QUESTION = /^(?:can|could|would|will) you\b/;
/** A question about sending rather than a request to send. */
const ASKING =
  /^(?:should|shall|did|does|do|is|was|has|have|how|why|when|what|which|where|who|am|are|can i|could i|may i)\b/;
/** Words a request opens with that are not part of the ask. */
const OPENERS =
  /^(?:(?:ok|okay|yes|yeah|yep|great|perfect|thanks|thank you|cool|alright|all right|good|so|and|then|now|also|just|please|pls|go ahead and|ok so|right)[,.!]?\s+)+/;
/** A short yes, on its own. */
const SHORT_YES =
  /^(?:yes|yep|yeah|yup|sure|ok|okay|go ahead|go for it|do it|please do|sounds good|perfect|ship it|send|send it|yes please|yes,? send it|looks good)[.! ]*$/;
/** An answer that offered to send. */
const OFFERED = /\b(?:send|sending|forward)\b/;

/** The clauses of a message: sentences, and parts joined by "and"/"then"/";". */
function clauses(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?\n;])\s*|\s*\n\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Whether one clause asks for a send. */
function asksToSend(raw: string): boolean {
  const clause = raw.replace(OPENERS, '').trim();
  const question = clause.endsWith('?');
  const request = REQUEST_QUESTION.test(clause);
  if (question && !request && ASKING.test(clause)) return false;
  const body = clause
    .replace(REQUEST_QUESTION, '')
    .replace(/^\s*please\s+/, '')
    .trim();
  if (HELD.test(body) || OWN_DOING.test(body)) return false;
  if (SEND.test(body)) return true;
  if (DRAFT_ONLY.test(body)) return false;
  return LEADING_VERB.test(body);
}

/**
 * Whether the person's message asks for a send. `previous` is the agent's
 * answer just before it, which a short yes answers.
 */
export function saysToSend(text: string, previous = ''): boolean {
  const said = clauses(text);
  if (said.length === 0) return false;
  // One clause that holds back the send outweighs another that asks for it:
  // "draft it and send it, but don't send it before Monday" waits.
  if (said.some((clause) => HELD.test(clause) && SEND.test(clause))) return false;
  if (said.some(asksToSend)) return true;
  const whole = said.join(' ');
  return SHORT_YES.test(whole) && OFFERED.test(previous.toLowerCase());
}

/**
 * Whether the person said to send in the turn this attempt answers. Only a
 * turn a person wrote counts: a routine's own run or a wake has no author,
 * and its sends are judged as proactive work instead.
 */
export async function toldToSend(tx: Query, attemptId: string | null | undefined) {
  if (!attemptId) return false;
  const [turn] = await tx`select t.text,
      (select p.answer from experience_turn p where p.job_id = t.job_id
        and p.created_at < t.created_at order by p.created_at desc, p.id desc limit 1) as previous
    from attempt a join experience_turn t on t.id = a.turn_id and t.job_id = a.job_id
    where a.id = ${attemptId} and t.author_principal_id is not null`;
  return turn ? saysToSend(String(turn.text ?? ''), String(turn.previous ?? '')) : false;
}

/** The same reading inside the runner's transaction, where an attempt's tools are listed. */
export async function toldToSendIn(tx: Transaction, attemptId: string | null | undefined) {
  if (!attemptId) return false;
  const [turn] = await tx.execute<Record<string, unknown>>(sql`select t.text,
      (select p.answer from experience_turn p where p.job_id = t.job_id
        and p.created_at < t.created_at order by p.created_at desc, p.id desc limit 1) as previous
    from attempt a join experience_turn t on t.id = a.turn_id and t.job_id = a.job_id
    where a.id = ${attemptId} and t.author_principal_id is not null`);
  return turn ? saysToSend(String(turn.text ?? ''), String(turn.previous ?? '')) : false;
}
