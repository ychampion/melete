/**
 * A message the agent writes stays a draft unless the person said to send it.
 *
 * In a chat the agent drafts; the person sends from the draft card. When the
 * person's own message in the turn being answered says to send ("send it",
 * "reply to Sam that …", a yes to "shall I send it?"), the send goes out on
 * its own, with a receipt that says why, and nothing else lets it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { actionReviewView } from '../../src/broker/auto-review.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver, type TrustTable } from '../../src/broker/trust.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const reply: JsonObject = {
  to: ['sam@example.com'],
  subject: 'Friday',
  body: 'Friday at 3 works for me.',
};
const ownRecipient: TrustTable = { 'sam@example.com': { origin_trust: 'owner' } };

async function setup(options: { chat?: boolean; trust?: TrustTable } = {}) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: emailManifest.tools.map((tool) => tool.name),
    provider: 'imap',
  });
  const personId = recordId('prn');
  await sql`insert into principal (id, email) values (${personId}, ${`${personId}@example.test`})`;
  const agentId = recordId('agt');
  await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
      standing_instruction, asks_before_acting)
    values (${agentId}, ${seed.claims.space_id}, 'Ada', 'Helper', 'blue', 'plain', 'dark', 'calm', '', false)`;
  await sql`update job set agent_id = ${agentId}, principal_id = ${personId},
      kind = ${options.chat === false ? 'job' : 'chat'}
    where id = ${seed.claims.job_id}`;
  const dispatched: string[] = [];
  const connector: Connector = {
    manifest: emailManifest,
    async execute(action) {
      dispatched.push(action.kind);
      return {
        outcome: 'succeeded',
        receipt: {
          action_id: action.id,
          connection_id: action.connection_id,
          external_ref: action.id,
          received_at: new Date().toISOString(),
          late: false,
          detail: {},
        },
      };
    },
    async verify() {
      return { decision: 'unsupported', reason: 'fixture' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
  const broker = new BrokerService({
    sql,
    connectors: { get: (id: string) => (id === seed.connectionId ? connector : undefined) },
    resolveTrust: createTableTrustResolver(options.trust ?? ownRecipient),
    autoReview: { reviewer: null },
  });

  /**
   * The person says `text` (no one, when `author` is null) and an attempt answers it.
   */
  const turn = async (text: string, author: string | null = personId) => {
    const turnId = recordId('trn');
    await sql`insert into experience_turn (id, job_id, agent_id, submission_id, author_principal_id,
        text, answer, status)
      values (${turnId}, ${seed.claims.job_id}, ${agentId}, ${recordId('sub')}, ${author}, ${text},
        '', 'running')`;
    const attemptId = recordId('att');
    const [job] = await sql`update job set current_turn_id = ${turnId},
        lease_epoch = lease_epoch + 1 where id = ${seed.claims.job_id} returning lease_epoch`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, turn_id)
      values (${attemptId}, ${seed.claims.job_id}, ${job?.lease_epoch}, 'fake', 'fake', 'scripted', ${turnId})`;
    const claims = { ...seed.claims, attempt_id: attemptId, epoch: Number(job?.lease_epoch) };
    return {
      claims,
      propose: (kind: string, payload: JsonObject) =>
        broker.propose(claims, { connection_id: seed.connectionId, kind, payload }),
      /** The agent's answer, recorded as the turn ends. */
      answered: async (answer: string) => {
        await sql`update experience_turn set answer = ${answer}, status = 'completed',
            finished_at = clock_timestamp() where id = ${turnId}`;
      },
    };
  };

  return { ...seed, sql, broker, turn, dispatched };
}

describe('in a chat', () => {
  databaseTest('a message the person did not say to send is drafted, never sent', async () => {
    const s = await setup();
    const asked = await s.turn('Draft a reply to Sam saying Friday works');
    expect((await asked.propose('email.draft', reply)).status).toBe('succeeded');
    const error = await rejectionOf(asked.propose('email.send', reply));
    expect((error as Error).message).toContain('draft card');
    expect(s.dispatched).toEqual(['email.draft']);
  });

  databaseTest('"send it" in a later message sends it, with a receipt that says why', async () => {
    const s = await setup();
    const first = await s.turn('Draft a reply to Sam saying Friday works');
    await first.propose('email.draft', reply);
    await first.answered('The draft to Sam is ready.');
    const second = await s.turn('Looks good, send it');
    const sent = await second.propose('email.send', reply);
    expect(sent.status).toBe('succeeded');
    expect(s.dispatched).toEqual(['email.draft', 'email.send']);
    expect(await actionReviewView(s.sql, sent.action_id)).toMatchObject({
      outcome: 'auto_approved',
      by: 'policy',
      reason: 'You said to send it in your message.',
    });
  });

  databaseTest('a yes to the agent offering to send sends it', async () => {
    const s = await setup();
    const first = await s.turn('Write Sam a reply saying Friday works');
    await first.propose('email.draft', reply);
    await first.answered('The draft to Sam is ready. Shall I send it?');
    const second = await s.turn('yes');
    expect((await second.propose('email.send', reply)).status).toBe('succeeded');
  });

  databaseTest('"don\'t send it yet" keeps it a draft', async () => {
    const s = await setup();
    const asked = await s.turn("Reply to Sam that Friday works, but don't send it yet");
    await rejectionOf(asked.propose('email.send', reply));
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('a turn no person wrote cannot say to send', async () => {
    const s = await setup();
    const woke = await s.turn('Send it', null);
    await rejectionOf(woke.propose('email.send', reply));
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('told to send, to an address Melete cannot vouch for, it still asks', async () => {
    const s = await setup({ trust: {} });
    const asked = await s.turn('Send it');
    const sent = await asked.propose('email.send', reply);
    expect(sent.status).toBe('needs_approval');
    expect(s.dispatched).toEqual([]);
  });
});

describe('outside a chat', () => {
  databaseTest('a send nobody said to make waits on its card, with the whole draft', async () => {
    const s = await setup({ chat: false });
    const asked = await s.turn('Look through my inbox and tidy it');
    const proposal = await asked.propose('email.send', reply);
    expect(proposal.status).toBe('needs_approval');
    expect(s.dispatched).toEqual([]);
  });
});
