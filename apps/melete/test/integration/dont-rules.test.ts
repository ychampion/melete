/**
 * The agent goes ahead on its own, except where the person said not to.
 *
 * A "don't" the person said, in their memory, in the agent's instructions or
 * earlier in the chat, puts a card in front of an action it covers, and the
 * card quotes the rule and says where it came from. With no rule, the same
 * action goes ahead.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { actionReviewView } from '../../src/broker/auto-review.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { newId } from '../../src/ids.ts';
import { seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const toBob: JsonObject = {
  to: ['bob@example.com'],
  subject: 'Friday',
  body: 'Friday at 3 works for me.',
};

async function setup(options: { instruction?: string; chat?: boolean } = {}) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: emailManifest.tools.map((tool) => tool.name),
    provider: 'imap',
  });
  const spaceId = seed.claims.space_id;
  const personId = recordId('prn');
  await sql`insert into principal (id, email) values (${personId}, ${`${personId}@example.test`})`;
  await sql`update space set owner_principal_id = ${personId} where id = ${spaceId}`;
  // There is one owner row per install; every space's memory belongs to it.
  const [existing] = await sql`select id from owner limit 1`;
  const ownerId = existing ? String(existing.id) : newId('own');
  if (!existing)
    await sql`insert into owner (id, email) values (${ownerId}, 'dont-rules@example.test')`;
  await sql`insert into memory_spaces (space_id, owner_id, restore_ready) values (${spaceId}, ${ownerId}, true)`;
  const agentId = recordId('agt');
  await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
      standing_instruction, asks_before_acting)
    values (${agentId}, ${spaceId}, 'Ada', 'Helper', 'blue', 'plain', 'dark', 'calm',
      ${options.instruction ?? ''}, false)`;
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
    resolveTrust: createTableTrustResolver({ 'bob@example.com': { origin_trust: 'owner' } }),
    autoReview: { reviewer: null },
  });

  /** Something the person told Melete, saved in their memory. */
  const remember = async (content: string, originTrust = 'owner') => {
    const claimId = newId('k');
    const key = `pref.rule.${claimId.slice(-6).toLowerCase()}`;
    await sql`insert into memory_claims (id, space_id, domain_key, key, audience, head_revision)
      values (${claimId}, ${spaceId}, ${key}, ${key}, 'private', 1)`;
    await sql`insert into memory_revisions
      (claim_id, revision, kind, factual_status, status, valid_from, data_revision, origin_trust)
      values (${claimId}, 1, 'preference', 'asserted', 'active', now(), 1, ${originTrust})`;
    await sql`insert into memory_revision_content (claim_id, revision, content)
      values (${claimId}, 1, ${content})`;
  };

  /** The person says `text`, and an attempt answers it. */
  const turn = async (
    text: string,
    author: string = personId,
    usageClass: 'interactive' | 'background' = 'interactive',
  ) => {
    const turnId = recordId('trn');
    await sql`insert into experience_turn (id, job_id, agent_id, submission_id, author_principal_id,
        text, answer, status)
      values (${turnId}, ${seed.claims.job_id}, ${agentId}, ${recordId('sub')}, ${author}, ${text},
        '', 'running')`;
    const attemptId = recordId('att');
    const [job] = await sql`update job set current_turn_id = ${turnId},
        lease_epoch = lease_epoch + 1 where id = ${seed.claims.job_id} returning lease_epoch`;
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model, turn_id, class)
      values (${attemptId}, ${seed.claims.job_id}, ${job?.lease_epoch}, 'fake', 'fake', 'scripted',
        ${turnId}, ${usageClass})`;
    const claims = { ...seed.claims, attempt_id: attemptId, epoch: Number(job?.lease_epoch) };
    return {
      claims,
      propose: (kind: string, payload: JsonObject) =>
        broker.propose(claims, { connection_id: seed.connectionId, kind, payload }),
      answered: async (answer: string) => {
        await sql`update experience_turn set answer = ${answer}, status = 'completed',
            finished_at = clock_timestamp() where id = ${turnId}`;
      },
    };
  };

  /** A draft to Bob in one message, then "send it" in the next. */
  const draftThenSend = async () => {
    const first = await turn('Draft a reply to Bob saying Friday works');
    await first.propose('email.draft', toBob);
    await first.answered('The draft to Bob is ready.');
    const second = await turn('Looks good, send it');
    return second.propose('email.send', toBob);
  };

  /** Someone else in the conversation, as in a room. */
  const someoneElse = recordId('prn');
  await sql`insert into principal (id, email) values (${someoneElse}, ${`${someoneElse}@example.test`})`;

  return { sql, broker, remember, turn, draftThenSend, dispatched, someoneElse };
}

describe("the person's own don't-rules", () => {
  databaseTest('with no rule, a send the person asked for goes out', async () => {
    const s = await setup();
    await s.remember('Prefers short emails with no greeting');
    const sent = await s.draftThenSend();
    expect(sent.status).toBe('succeeded');
    expect(s.dispatched).toEqual(['email.draft', 'email.send']);
  });

  databaseTest('a rule in memory stops the send and the card quotes it', async () => {
    const s = await setup();
    await s.remember("Don't email Bob");
    const sent = await s.draftThenSend();
    expect(sent.status).toBe('needs_approval');
    expect(s.dispatched).toEqual(['email.draft']);
    expect(await actionReviewView(s.sql, sent.action_id)).toMatchObject({
      outcome: 'escalated',
      by: 'policy',
      reason:
        "It goes against something you said: “Don't email Bob” (you told Melete this, and it is in your memory).",
    });
  });

  databaseTest('once the person allows it on the card, it goes', async () => {
    const s = await setup();
    await s.remember("Don't email Bob");
    const asked = await s.turn('Send the notes from today');
    const proposal = await asked.propose('email.send', toBob);
    expect(proposal.status).toBe('needs_approval');
    await s.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    expect((await s.broker.resume(asked.claims, proposal.action_id)).status).toBe('succeeded');
    expect(s.dispatched).toEqual(['email.send']);
  });

  databaseTest('a rule in memory that no one vouches for as the person is not theirs', async () => {
    const s = await setup();
    // Words read from an email or a page, saved as such, are not the person's rule.
    await s.remember("Don't email Bob", 'external_content');
    await s.remember("Don't email Bob", 'inferred');
    expect((await s.draftThenSend()).status).toBe('succeeded');
  });

  databaseTest("a rule in the agent's instructions is cited as that", async () => {
    const s = await setup({ instruction: 'Be brief. Never email Bob without checking with me.' });
    const sent = await s.draftThenSend();
    expect(sent.status).toBe('needs_approval');
    expect((await actionReviewView(s.sql, sent.action_id))?.reason).toContain(
      "it is in this agent's instructions",
    );
  });

  databaseTest('a rule said earlier in the chat is cited as that', async () => {
    const s = await setup();
    const earlier = await s.turn('Please do not email Bob until Monday');
    await earlier.answered('Got it.');
    const sent = await s.draftThenSend();
    expect(sent.status).toBe('needs_approval');
    expect((await actionReviewView(s.sql, sent.action_id))?.reason).toContain(
      'you said this earlier in this chat',
    );
  });

  databaseTest('asking for it in this message outweighs an older rule', async () => {
    const s = await setup();
    await s.remember("Don't email Bob");
    const asked = await s.turn('Email Bob that Friday works and send it');
    expect((await asked.propose('email.send', toBob)).status).toBe('succeeded');
    expect(s.dispatched).toEqual(['email.send']);
  });

  databaseTest(
    'a later wake of the conversation does not lift a rule with its old message',
    async () => {
      // Outside a chat, where a send is judged rather than kept to its draft card.
      const s = await setup({ chat: false });
      await s.remember("Don't email Bob");
      const woke = await s.turn('Email Bob that Friday works', undefined, 'background');
      const proposal = await woke.propose('email.send', toBob);
      expect(proposal.status).toBe('needs_approval');
      expect((await actionReviewView(s.sql, proposal.action_id))?.reason).toContain(
        "“Don't email Bob”",
      );
      expect(s.dispatched).toEqual([]);
    },
  );

  databaseTest("someone else's message neither lifts the person's rule nor sets one", async () => {
    const s = await setup();
    await s.remember("Don't email Bob");
    const asked = await s.turn('Email Bob that Friday works and send it', s.someoneElse);
    expect((await asked.propose('email.send', toBob)).status).not.toBe('succeeded');
    expect(s.dispatched).toEqual([]);

    const other = await setup();
    const earlier = await other.turn('Do not email Bob', other.someoneElse);
    await earlier.answered('Noted.');
    expect((await other.draftThenSend()).status).toBe('succeeded');
  });

  databaseTest('a rule about someone else leaves the send alone', async () => {
    const s = await setup();
    await s.remember("Don't email Sam");
    expect((await s.draftThenSend()).status).toBe('succeeded');
  });
});
