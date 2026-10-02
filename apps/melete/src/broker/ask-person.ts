/**
 * The agent's one way to ask the person something and wait for the answer.
 *
 * Asking writes nothing outside the installation and needs no approval: the
 * broker records the question against this attempt, and when the attempt
 * settles the service puts it in the person's queue and the job waits for
 * input. The answer comes back as the person's next message. Approvals never
 * travel this way; a tool that needs one is proposed and the broker asks.
 */
import {
  type CapabilityClaims,
  canonicalizePayload,
  type QuestionSpec,
  questionSpec,
  type ToolSpec,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BrokerFault } from './errors.ts';
import { appendEvent, checkAttempt, lockJob } from './records.ts';

export const ASK_PERSON_TOOL_NAME = 'ask_person';

/** The event kind and dedup suffix the question is recorded under. */
export const PERSON_QUESTION_KIND = 'person_question_requested';
export const personQuestionKey = (attemptId: string) => `${attemptId}:ask-person`;

/** At most this many choices: the queue's decision card shows four. */
const MAX_CHOICES = 4;

export const ASK_PERSON_TOOL: ToolSpec = {
  name: ASK_PERSON_TOOL_NAME,
  description:
    'Ask the person one question and wait for their answer, then end this turn. Use it only when the request is genuinely ambiguous or the choice is theirs to make. Never use it to ask permission for an action: propose the action and the person is asked to approve it.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 500 },
      choices: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 120 },
        maxItems: MAX_CHOICES,
        description:
          'Up to four short answers the person can pick. They can always type their own.',
      },
      why: {
        type: 'string',
        maxLength: 300,
        description: 'One short sentence on why the answer matters.',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

const askInput = z.strictObject({
  question: z.string().trim().min(1).max(500),
  choices: z.array(z.string().trim().min(1).max(120)).max(MAX_CHOICES).optional(),
  why: z.string().trim().max(300).optional(),
});

/** The same question with its choices in one place; a resent call matches it. */
function specOf(input: z.infer<typeof askInput>, attemptId: string): QuestionSpec {
  const labels = [...new Set(input.choices ?? [])];
  return questionSpec.parse({
    text: input.question,
    because: [`attempt:${attemptId}`],
    if_ignored: 'This waits for your answer.',
    ...(labels.length
      ? { options: labels.map((label, index) => ({ id: `choice_${index + 1}`, label })) }
      : {}),
    ...(input.why ? { why: input.why } : {}),
  });
}

export async function requestPersonQuestion(sql: Sql, claims: CapabilityClaims, input: unknown) {
  const parsed = askInput.safeParse(input);
  if (!parsed.success)
    throw new BrokerFault(
      'payload_invalid',
      'ask_person needs a question, up to four choices of at most 120 characters, and an optional short why.',
    );
  const spec = specOf(parsed.data, claims.attempt_id);
  return sql.begin(async (tx) => {
    const job = await lockJob(tx, claims.job_id);
    await checkAttempt(tx, job, claims);
    const [open] =
      await tx`SELECT text FROM question WHERE job_id=${job.id} AND state='open' LIMIT 1`;
    if (open)
      throw new BrokerFault(
        'payload_invalid',
        `A question is already waiting for the person: "${String(open.text).slice(0, 300)}". End this turn; their answer comes back as their next message.`,
      );
    const [waiting] =
      await tx`SELECT 1 FROM event WHERE dedup_key=${`${claims.attempt_id}:runtime-wait`}`;
    if (waiting)
      throw new BrokerFault(
        'payload_invalid',
        'This turn already set a wait. Ask on a later turn, or end this one.',
      );
    const key = personQuestionKey(claims.attempt_id);
    const [existing] = await tx`SELECT payload FROM event WHERE dedup_key=${key}`;
    if (
      existing &&
      canonicalizePayload(existing.payload.question).hash !== canonicalizePayload(spec).hash
    )
      throw new BrokerFault(
        'payload_invalid',
        'This turn already asked a question. End the turn and wait for the answer.',
      );
    await appendEvent(
      tx,
      job.id,
      claims.attempt_id,
      'notice',
      { kind: PERSON_QUESTION_KIND, question: spec },
      key,
    );
    return {
      status: 'waiting_for_input',
      question: spec.text,
      ...(spec.options ? { choices: spec.options.map((option) => option.label) } : {}),
      instruction:
        'The question is on the person’s screen. End this turn now and do not answer it yourself; their answer comes back as their next message.',
    };
  });
}
