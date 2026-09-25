import type { JsonObject, ToolSpec } from '@melete/contracts';
import type { LockedJob, Query } from './records.ts';

/**
 * The follow-up a chase's scope already covers, as a tool with no arguments.
 * The service writes the message: the approved one, word for word, under a
 * fixed line. The model only decides when to send it, so there is nothing in
 * it for the person to read again, and it is not asked again.
 */
export const CHASE_FOLLOW_UP_TOOL: ToolSpec = {
  name: 'chase.follow_up',
  description:
    'Send the next follow-up in this chase: the message the person already approved, again, under a short line the service writes. It needs no second approval and takes no arguments. To say anything new, draft a new message instead, and the person is asked.',
  effect_class: 'write_external',
  connection_id: null,
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

/** The next covered follow-up, as the proposal the broker makes for it. */
export type ChaseFollowUpProposal = { connection_id: string; kind: string; payload: JsonObject };

/** Where the broker learns about a job's chase scope; the experience lane supplies it. */
export type ChaseFollowUpPort = {
  /** Whether the job has a follow-up its scope would still cover, so the tool is offered. */
  available: (tx: Query, job: LockedJob) => Promise<boolean>;
  /** The next covered follow-up, or null when the scope covers none. */
  next: (tx: Query, job: LockedJob) => Promise<ChaseFollowUpProposal | null>;
};
