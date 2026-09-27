import { describe, expect, test } from 'bun:test';
import {
  type AwaitedReply,
  type CreateResponsibilityRequest,
  evaluateWatch,
  type TriggerSpec,
} from '@melete/contracts';
import { ServiceError } from '../api/errors.ts';
import { handleAwaitedReply, REPLY_PLAYBOOK } from './handle-reply.ts';
import { replyPayload } from './replies.ts';

const SPACE = 'sp_01J0000000000000000000000A';
const OWNER = 'own_01J0000000000000000000000B';
const QUESTION = 'Could you send a quote for the move and a day you could do it?';
const TEXT = `Subject: Moving the studio server\n\nWe are moving the server next month.\n${QUESTION}\nSam`;
const START = TEXT.indexOf(QUESTION);

const reply = (over: Partial<AwaitedReply> = {}): AwaitedReply => ({
  id: 'awr_01J0000000000000000000000C',
  space_id: SPACE,
  principal_id: OWNER,
  message_id: '<sent-001@studio.example>',
  to: 'service@deverillit.example',
  to_name: 'Deverill IT',
  subject: 'Moving the studio server',
  sent_at: '2026-09-12T09:00:00.000Z',
  evidence: {
    message_id: '<sent-001@studio.example>',
    quote: QUESTION,
    start: START,
    end: START + QUESTION.length,
  },
  status: 'found',
  job_id: null,
  ...over,
});

function deps() {
  const jobs: CreateResponsibilityRequest[] = [];
  const triggers: TriggerSpec[] = [];
  return {
    jobs,
    triggers,
    deps: {
      createJob: async (input: CreateResponsibilityRequest) => {
        jobs.push(input);
        return { id: 'job_01J0000000000000000000000D' };
      },
      createTrigger: async (_job: string, spec: TriggerSpec) => {
        triggers.push(spec);
        return { id: 'trg_1' };
      },
    },
  };
}

const input = (over: Partial<AwaitedReply> = {}, text = TEXT) => ({
  reply: reply(over),
  messageText: text,
  principalId: OWNER,
  spaceId: SPACE,
  connectionId: 'conn_mail',
});

async function refusal(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

describe('chasing a reply the person is waiting on', () => {
  test('starts one chase that runs the reply playbook, quoting what they asked', async () => {
    const { deps: made, jobs } = deps();
    expect(await handleAwaitedReply(made, input())).toEqual({
      job_id: 'job_01J0000000000000000000000D',
    });
    expect(jobs).toHaveLength(1);
    const objective = jobs[0]?.objective ?? '';
    expect(objective).toContain(`Playbook: ${REPLY_PLAYBOOK}.`);
    expect(objective).toContain(QUESTION);
    expect(objective).toContain('service@deverillit.example');
    expect(objective).toContain('Re: Moving the studio server');
    expect(jobs[0]?.constraints?.deliverable).toEqual({
      kind: 'message_sent',
      connection_id: 'conn_mail',
    });
  });

  test("a company's chase wakes for anyone at the company", async () => {
    const { deps: made, triggers } = deps();
    await handleAwaitedReply(made, input());
    const predicate = triggers[0]?.kind === 'watch' ? triggers[0].predicate : null;
    if (!predicate) throw new Error('Expected a watch');
    const from = (sender: string) =>
      replyPayload({
        messageId: '<r@x>',
        from: sender,
        subject: 'Re',
        receivedAt: '2026-09-15T09:00:00.000Z',
      });
    expect(evaluateWatch(predicate, from('accounts@deverillit.example'), null)).toBe(true);
    expect(evaluateWatch(predicate, from('someone@elsewhere.example'), null)).toBe(false);
  });

  test("a person's chase at a mail provider wakes for that person alone", async () => {
    const { deps: made, triggers } = deps();
    await handleAwaitedReply(made, input({ to: 'tomas.brennan@gmail.com', to_name: 'Tomas' }));
    const predicate = triggers[0]?.kind === 'watch' ? triggers[0].predicate : null;
    if (!predicate) throw new Error('Expected a watch');
    const from = (sender: string) =>
      replyPayload({
        messageId: '<r@x>',
        from: sender,
        subject: 'Re',
        receivedAt: '2026-09-15T09:00:00.000Z',
      });
    expect(evaluateWatch(predicate, from('Tomas <tomas.brennan@gmail.com>'), null)).toBe(true);
    expect(evaluateWatch(predicate, from('someone.else@gmail.com'), null)).toBe(false);
  });

  test('a question that no longer sits where it claims is refused, and nothing starts', async () => {
    const { deps: made, jobs } = deps();
    const error = await refusal(() =>
      handleAwaitedReply(made, input({}, TEXT.replace('Could you', 'Can you'))),
    );
    expect((error as ServiceError).code).toBe('evidence_failed');
    expect(jobs).toEqual([]);
  });

  test("someone else's reply, or one already chased or closed, is refused", async () => {
    const { deps: made, jobs } = deps();
    for (const [over, code] of [
      [{ principal_id: 'own_01J0000000000000000000000Z' }, 'scope_denied'],
      [{ space_id: 'sp_01J0000000000000000000000Z' }, 'scope_denied'],
      [{ job_id: 'job_01J0000000000000000000000E' }, 'already_handling'],
      [{ status: 'settled' }, 'already_terminal'],
    ] as const) {
      const error = await refusal(() => handleAwaitedReply(made, input(over)));
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).code).toBe(code);
    }
    expect(jobs).toEqual([]);
  });
});
