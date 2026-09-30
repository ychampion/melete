/**
 * Turning one reply the person is waiting on into a chase.
 *
 * This is "Handle it" for a message the person sent that nobody answered, and
 * it is built from the same parts: it composes a job and hands it to the job
 * service, writes no rows and sends nothing. The job's only way out is the
 * broker, so the first message to them asks the person, and the approval is
 * bound to the exact text.
 *
 * What is decided here rather than by the model:
 *
 * 1. **What may be quoted.** The sentence the person asked is re-checked
 *    against the stored text of their sent message before it reaches the
 *    objective; a sentence that no longer sits where it claims is refused.
 * 2. **Who a reply is from.** A company's chase wakes for anyone at the
 *    company. A person at a mail provider shares a domain with millions, so
 *    their chase wakes for their own address alone.
 */
import { type AwaitedReply, evidenceHolds, type PlaybookId } from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import { HANDLE_BUDGET, type HandleDeps, oneLine, REPLY_EVENT_NAME, replyWatch } from './handle.ts';
import { registrableDomain } from './messages.ts';
import { isPersonalDomain } from './waiting.ts';

/** The playbook a reply chase runs. */
export const REPLY_PLAYBOOK: PlaybookId = 'chase-reply';

export type HandleReplyInput = {
  reply: AwaitedReply;
  /** The stored text of the person's sent message, which the evidence indexes into. */
  messageText: string;
  principalId: string;
  spaceId: string;
  /** The mail connection the follow-up goes out on, when one is connected. */
  connectionId?: string;
};

/** The subject a follow-up carries, so it lands in the same thread. */
export function replySubject(subject: string): string {
  const base = subject.trim().replace(/^(?:re\s*:\s*)+/i, '');
  return `Re: ${base}`;
}

/** The job's objective, which also mounts the playbook by naming it. */
export function replyObjective(input: HandleReplyInput, replyEvent: string | null): string {
  const { reply } = input;
  const who = reply.to_name ? `${oneLine(reply.to_name, 200)} (${reply.to})` : reply.to;
  return [
    `Playbook: ${REPLY_PLAYBOOK}.`,
    '',
    `Run the ${REPLY_PLAYBOOK} playbook for one message the person is waiting on a reply to, and nothing else.`,
    '',
    `Waiting on: ${who}`,
    `Their message: "${oneLine(reply.subject, 300)}", sent ${reply.sent_at}`,
    `Awaited reply: ${reply.id}`,
    '',
    'What the person asked, in their own words. This is the exact sentence from',
    'their sent message, re-checked against it:',
    `"${oneLine(reply.evidence.quote, 2000)}" — ${reply.message_id}`,
    '',
    `Write one short follow-up from the person's own address to ${reply.to} alone,`,
    `as a reply in the same thread, with the subject "${replySubject(oneLine(reply.subject, 300))}".`,
    'The first message out needs their approval and the approval shows them the',
    'exact text; wait for it rather than assuming it.',
    ...(replyEvent
      ? [
          `A reply arrives on this job's ${replyEvent} trigger. Wait on it with a deadline`,
          "at the playbook's cadence, so a reply wakes this and silence still does.",
        ]
      : ['No reply trigger is registered here, so wait on a timer at the playbook cadence.']),
    'Whenever you wake, search the mail for their reply before deciding anything.',
    'A follow-up is for silence; if they wrote back, tell the person what they said.',
    '',
    `The ${REPLY_PLAYBOOK} instructions above govern the wording, the cadence and when to stop.`,
  ].join('\n');
}

/** Start chasing one reply. Nothing is sent by the time this resolves. */
export async function handleAwaitedReply(
  deps: HandleDeps,
  input: HandleReplyInput,
): Promise<{ job_id: string }> {
  const { reply, principalId, spaceId } = input;
  if (reply.space_id !== spaceId)
    throw new ServiceError('scope_denied', 'That message is not in this space.', 403);
  if (reply.principal_id !== principalId)
    throw new ServiceError('scope_denied', 'That message belongs to someone else.', 403);
  if (reply.status === 'settled' || reply.status === 'dropped')
    throw new ServiceError('already_terminal', 'This one is already finished.', 409);
  if (reply.job_id)
    throw new ServiceError('already_handling', 'This one is already being chased.', 409);
  if (!evidenceHolds(input.messageText, reply.evidence))
    throw new ServiceError(
      'evidence_failed',
      'What you asked can no longer be quoted from your message.',
      409,
    );

  const domain = registrableDomain(reply.to);
  const replyEvent = deps.createTrigger && input.connectionId ? REPLY_EVENT_NAME : null;
  const job = await deps.createJob({
    space_id: spaceId,
    title: oneLine(`${reply.to_name ?? reply.to}: ${reply.subject || 'your message'}`, 200),
    objective: replyObjective(input, replyEvent),
    constraints: {
      ...(input.connectionId
        ? { deliverable: { kind: 'message_sent' as const, connection_id: input.connectionId } }
        : {}),
      // The reply watcher finds a chase by the domain it may reach, so the
      // recipient's is named even where nothing there is worth fetching.
      allowed_domains: domain ? [domain] : [],
      public_compartment: false,
      notes: `Chasing ${reply.id} with the ${REPLY_PLAYBOOK} playbook.`,
    },
    budget: HANDLE_BUDGET,
    importance: 'important',
    scheduling_class: 'background',
  });

  if (deps.createTrigger && input.connectionId && replyEvent && domain)
    await deps.createTrigger(job.id, {
      kind: 'watch',
      connection_id: input.connectionId,
      event_name: replyEvent,
      predicate: isPersonalDomain(domain)
        ? { all: [{ field: 'sender', op: 'eq' as const, value: reply.to }] }
        : replyWatch(domain),
      poll_seconds: 300,
    });

  return { job_id: job.id };
}
