/**
 * What a person is waiting on: the money companies owe them, and the replies
 * nobody has sent yet. Both are things they can chase, so both are read as one
 * list, and the few worth chasing first are picked out.
 *
 * An awaited reply is found the way a ledger item is: out of the person's own
 * mail, with the sentence it rests on kept at a span that `evidenceHolds`
 * checks. Its sentence is the person's own question rather than a company's
 * words, so it is shown as what they asked.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import { currencyCode, ledgerEvidence, ledgerItemStatus, minorAmount } from './companies.ts';

export const awaitedReply = z.strictObject({
  id: prefixedId(ID_PREFIXES.awaited_reply),
  space_id: prefixedId(ID_PREFIXES.space),
  principal_id: prefixedId(ID_PREFIXES.owner),
  /** The sent message, as the store knows it. */
  message_id: z.string().min(1).max(998),
  /** The address the reply is awaited from. */
  to: z.string().min(3).max(320),
  to_name: z.string().max(200).nullable(),
  subject: z.string().max(998),
  sent_at: timestamp,
  /** The sentence that asked, in the person's own sent message. */
  evidence: ledgerEvidence,
  status: ledgerItemStatus,
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
});
export type AwaitedReply = z.infer<typeof awaitedReply>;

/**
 * One thing being waited on, in the shape both kinds share. `kind` says which
 * route chases it: an owed item through `POST /ledger/{id}/handle`, a reply
 * through `POST /waiting-on/replies/{id}/chase`.
 */
export const waitingOnEntry = z.strictObject({
  kind: z.enum(['owed', 'reply']),
  id: z.string().min(1).max(64),
  /** Who it is waited on: the company, or the person or company written to. */
  who: z.string().min(1).max(320),
  /** One line: the item's summary, or what the message asked. */
  what: z.string().min(1).max(500),
  amount_minor: minorAmount.nullable(),
  currency: currencyCode.nullable(),
  /** When an owed item falls due, when it has a date. */
  due_at: timestamp.nullable(),
  /** When the message waiting on a reply went out. */
  sent_at: timestamp.nullable(),
  status: ledgerItemStatus,
  /** The chase handling it, once there is one. */
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
});
export type WaitingOnEntry = z.infer<typeof waitingOnEntry>;

export const WAITING_ON_TOP = 3;

export const waitingOn = z.strictObject({
  /** The currency `owed_minor` is in, the company map's own. */
  currency: currencyCode,
  /** What companies owe the person, the same figure the company map shows. */
  owed_minor: minorAmount,
  owed: z.array(waitingOnEntry),
  replies: z.array(waitingOnEntry),
  /** The few to chase first: nothing is chasing them yet. */
  top: z.array(waitingOnEntry).max(WAITING_ON_TOP),
  /**
   * Whether a mailbox is connected, and how its latest scan went, for the space
   * named here: the one a scan should be started in, and the one to name in
   * `space_id` while waiting for it.
   */
  scan: z.strictObject({
    space_id: prefixedId(ID_PREFIXES.space).nullable(),
    connected: z.boolean(),
    status: z.enum(['none', 'running', 'done', 'failed']),
    finished_at: timestamp.nullable(),
    /**
     * The latest scan finished without reading what the person sent, though
     * this mailbox can, so no reply they wait on is known yet. One more scan
     * finds them.
     */
    stale: z.boolean(),
  }),
});
export type WaitingOn = z.infer<typeof waitingOn>;
