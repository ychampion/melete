/**
 * Work nobody is waiting on is never asked about by default.
 *
 * When a schedule, a timer or an event wakes work that would reach someone
 * outside Melete, it goes ahead on its own when what the person said before
 * makes it likely they want it, with a receipt that gives the score and the
 * reasons, and is otherwise left as a quiet suggestion: nothing is sent and no
 * card is raised.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ConnectorManifest, JsonObject } from '@melete/contracts';
import { actionReviewView } from '../../src/broker/auto-review.ts';
import { type Query, recordId } from '../../src/broker/records.ts';
import { BrokerService, ProactiveHold } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { newId } from '../../src/ids.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createPostgresFixture } from '../helpers/postgres.ts';

const fixture = await createPostgresFixture();
const databaseTest = fixture ? test : test.skip;
afterAll(async () => {
  await fixture?.close();
});

const tool = (name: string, properties: string[]) => ({
  name,
  description: name,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(properties.map((key) => [key, { type: 'string' }])),
    additionalProperties: false,
  },
  effect_class: 'write_external' as const,
  required_scopes: [name],
  requires_approval: true,
  verify: false,
});
const manifest: ConnectorManifest = {
  name: 'test',
  provider: 'test',
  version: '1',
  description: 'Scripted mail and messages',
  credentials: [],
  health: true,
  tools: [
    tool('test.send_email', ['to', 'subject', 'body']),
    tool('test.send_message', ['to', 'text']),
    tool('test.send_secret', ['to', 'text', 'api_key']),
  ],
};
const mailBob = (body = 'This week went well.'): JsonObject => ({
  to: 'bob@example.com',
  subject: 'Weekly summary',
  body,
});
const messageBob = (text = 'Running five minutes late.'): JsonObject => ({
  to: 'bob@example.com',
  text,
});

async function setup(
  options: {
    routine?: string;
    instruction?: string;
    messagesToOthers?: 'confidence' | 'draft_only';
  } = {},
) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const sql = fixture.sql;
  const seed = await seedJob(sql, {
    scopes: manifest.tools.map((item) => item.name),
    provider: 'test',
  });
  const spaceId = seed.claims.space_id;
  const personId = recordId('prn');
  await sql`insert into principal (id, email) values (${personId}, ${`${personId}@example.test`})`;
  await sql`update space set owner_principal_id = ${personId} where id = ${spaceId}`;
  const [existing] = await sql`select id from owner limit 1`;
  const ownerId = existing ? String(existing.id) : newId('own');
  if (!existing)
    await sql`insert into owner (id, email) values (${ownerId}, 'proactive@example.test')`;
  await sql`insert into memory_spaces (space_id, owner_id, restore_ready) values (${spaceId}, ${ownerId}, true)`;
  const agentId = recordId('agt');
  await sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
      standing_instruction, asks_before_acting)
    values (${agentId}, ${spaceId}, 'Ada', 'Helper', 'blue', 'plain', 'dark', 'calm',
      ${options.instruction ?? ''}, false)`;
  await sql`update job set agent_id = ${agentId}, principal_id = ${personId}, kind = 'routine',
      objective = ${options.routine ?? 'Keep my inbox tidy'}, objective_origin = 'owner_request'
    where id = ${seed.claims.job_id}`;
  const dispatched: string[] = [];
  let admitting: ((tx: Query) => Promise<void>) | null = null;
  const connector: Connector = {
    manifest,
    async validateBinding(_action, _ctx, tx) {
      const run = admitting;
      admitting = null;
      await run?.(tx);
    },
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
    ...(options.messagesToOthers ? { messagesToOthers: options.messagesToOthers } : {}),
  });

  /** An attempt: woken by a schedule (`background`), or answering the person. */
  const attempt = async (usageClass: 'interactive' | 'background', author = personId) => {
    const turnId = recordId('trn');
    await sql`insert into experience_turn (id, job_id, agent_id, submission_id, author_principal_id,
        text, answer, status)
      values (${turnId}, ${seed.claims.job_id}, ${agentId}, ${recordId('sub')},
        ${usageClass === 'interactive' ? author : null}, 'Go', '', 'running')`;
    const attemptId = recordId('att');
    // The shift before rested until its schedule woke the work again.
    await sql`update attempt set outcome = 'waiting_for_event_or_time', ended_at = now()
      where job_id = ${seed.claims.job_id} and ended_at is null`;
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
    };
  };

  /** Something the person told Melete themselves. */
  const remember = async (content: string) => {
    const claimId = newId('k');
    const key = `pref.note.${claimId.slice(-6).toLowerCase()}`;
    await sql`insert into memory_claims (id, space_id, domain_key, key, audience, head_revision)
      values (${claimId}, ${spaceId}, ${key}, ${key}, 'private', 1)`;
    await sql`insert into memory_revisions
      (claim_id, revision, kind, factual_status, status, valid_from, data_revision, origin_trust)
      values (${claimId}, 1, 'preference', 'asserted', 'active', now(), 1, 'owner')`;
    await sql`insert into memory_revision_content (claim_id, revision, content)
      values (${claimId}, 1, ${content})`;
  };

  /** One the person (or `by`) was asked about earlier, while they were there, and answered. */
  const answered = async (
    kind: string,
    payload: JsonObject,
    decision: 'approved' | 'denied',
    by?: string,
  ) => {
    const there = await attempt('interactive', by ?? personId);
    const asked = await there.propose(kind, payload);
    expect(asked.status).toBe('needs_approval');
    await broker.decide(
      asked.action_id,
      { decision, payload_hash: asked.payload_hash },
      undefined,
      by,
    );
    if (decision === 'approved')
      expect((await broker.resume(there.claims, asked.action_id)).status).toBe('succeeded');
  };

  const suggestions = async () =>
    sql`select payload from event where job_id = ${seed.claims.job_id}
      and type = 'notice' and payload->>'phase' = 'proactive_suggestion' order by seq`;
  const cards = async () =>
    sql`select p.id from approval p join action a on a.id = p.action_id
      where a.job_id = ${seed.claims.job_id} and p.decision is null`;
  const pushes = async () => sql`select id from push_intent where principal_id = ${personId}`;

  /** The job's first shift, started in the background with nothing that woke it. */
  const firstShift = async () => {
    await sql`update attempt set class = 'background' where id = ${seed.claims.attempt_id}`;
    return {
      propose: (kind: string, payload: JsonObject) =>
        broker.propose(seed.claims, { connection_id: seed.connectionId, kind, payload }),
    };
  };

  /** Someone else with access to the same work. */
  const someoneElse = recordId('prn');
  await sql`insert into principal (id, email) values (${someoneElse}, ${`${someoneElse}@example.test`})`;

  return {
    sql,
    broker,
    someoneElse,
    /** Runs once inside the next admission's transaction, before it judges the action. */
    atAdmission: (run: (tx: Query) => Promise<void>) => {
      admitting = run;
    },
    attempt,
    firstShift,
    remember,
    answered,
    suggestions,
    cards,
    pushes,
    dispatched,
  };
}

describe('work nobody is waiting on', () => {
  databaseTest(
    'with nothing the person said behind it, nothing is sent, nobody is asked, and it is left as a suggestion',
    async () => {
      const s = await setup();
      const woke = await s.attempt('background');
      const hold = await rejectionOf(woke.propose('test.send_email', mailBob()));
      expect(hold).toBeInstanceOf(ProactiveHold);
      expect((hold as Error).message).toContain('confidence 0.00');
      expect(s.dispatched).toEqual([]);
      expect(await s.cards()).toHaveLength(0);
      expect(await s.pushes()).toHaveLength(0);
      const [suggestion] = await s.suggestions();
      expect(suggestion?.payload).toMatchObject({
        kind: 'test.send_email',
        confidence: 0,
        threshold: 0.6,
      });
      // A quiet row in the conversation says what was not done and why.
      const [row] = await s.sql`select payload from event where job_id = ${woke.claims.job_id}
        and type = 'notice' and payload ? 'call' order by seq desc limit 1`;
      expect(row?.payload.call).toMatchObject({
        title: 'Left as a suggestion: test.send_email to bob@example.com',
        status: 'done',
      });
      expect(row?.payload.call.output_summary.text).toStartWith('Not sent, left as a suggestion');
    },
  );

  databaseTest(
    'the routine the person wrote asking for it lets it go, with the score and the reason on its receipt',
    async () => {
      const s = await setup({ routine: 'Every Friday, email Bob the weekly summary.' });
      const woke = await s.attempt('background');
      const sent = await woke.propose('test.send_email', mailBob());
      expect(sent.status).toBe('succeeded');
      expect(s.dispatched).toEqual(['test.send_email']);
      expect(await actionReviewView(s.sql, sent.action_id)).toMatchObject({
        outcome: 'auto_approved',
        by: 'policy',
        reason:
          'Confidence is 0.60 from what you said before: your routine says “Every Friday, email Bob the weekly summary.”. The default for email to other people: “Draft”.',
      });
    },
  );

  databaseTest('a routine that asks for it to someone else does not count', async () => {
    const s = await setup({ routine: 'Every Friday, email Sam the weekly summary.' });
    const woke = await s.attempt('background');
    expect(await rejectionOf(woke.propose('test.send_email', mailBob()))).toBeInstanceOf(
      ProactiveHold,
    );
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('instructions that hold it for the person do not count', async () => {
    const s = await setup({
      instruction: 'Draft replies in my voice and show each draft before it is sent.',
    });
    const woke = await s.attempt('background');
    expect(await rejectionOf(woke.propose('test.send_email', mailBob()))).toBeInstanceOf(
      ProactiveHold,
    );
  });

  databaseTest(
    'a stated preference and two past sends the person allowed let a message go, never an email',
    async () => {
      const s = await setup();
      await s.remember('I always message Bob when I am running late.');
      await s.answered('test.send_message', messageBob('Late, sorry.'), 'approved');
      await s.answered('test.send_message', messageBob('Ten minutes behind.'), 'approved');
      const woke = await s.attempt('background');
      const sent = await woke.propose('test.send_message', messageBob());
      expect(sent.status).toBe('succeeded');
      const review = await actionReviewView(s.sql, sent.action_id);
      expect(review?.reason).toStartWith('Confidence is 0.60 from what you said before');
      expect(review?.reason).toContain('you told Melete “I always message Bob');
      expect(review?.reason).toContain('you allowed a similar one to bob@example.com');

      // The same evidence for an email is not enough: mail needs the instruction itself.
      await s.remember('I always email Bob when I am running late.');
      await s.answered('test.send_email', mailBob('Late, sorry.'), 'approved');
      await s.answered('test.send_email', mailBob('Ten minutes behind.'), 'approved');
      const again = await s.attempt('background');
      const hold = await rejectionOf(again.propose('test.send_email', mailBob()));
      expect(hold).toBeInstanceOf(ProactiveHold);
      expect((hold as ProactiveHold).confidence.missing.join(' ')).toContain('an email goes out');
    },
  );

  databaseTest('a routine that only describes the work does not ask for a send', async () => {
    const s = await setup({ routine: 'You manage my email. Bob writes most weeks.' });
    const woke = await s.attempt('background');
    expect(await rejectionOf(woke.propose('test.send_message', messageBob()))).toBeInstanceOf(
      ProactiveHold,
    );
    expect(s.dispatched).toEqual([]);
    expect(await s.cards()).toHaveLength(0);
  });

  databaseTest('sends someone else allowed are not the person allowing them', async () => {
    const s = await setup();
    await s.remember('I always message Bob when I am running late.');
    await s.answered('test.send_message', messageBob('Late, sorry.'), 'approved', s.someoneElse);
    await s.answered(
      'test.send_message',
      messageBob('Ten minutes behind.'),
      'approved',
      s.someoneElse,
    );
    const woke = await s.attempt('background');
    const hold = await rejectionOf(woke.propose('test.send_message', messageBob()));
    expect(hold).toBeInstanceOf(ProactiveHold);
    expect((hold as ProactiveHold).confidence.score).toBe(0.3);
    expect(s.dispatched).toEqual(['test.send_message', 'test.send_message']);
  });

  databaseTest(
    'a send that was likely when proposed but is not by admission raises no card',
    async () => {
      const s = await setup({ instruction: 'Every Friday, email Bob the weekly summary.' });
      const woke = await s.attempt('background');
      // Between the proposal and its admission, the instructions stop asking for it.
      s.atAdmission(async (tx) => {
        await tx`update agent set standing_instruction = '' where space_id = ${woke.claims.space_id}`;
      });
      const hold = await rejectionOf(woke.propose('test.send_email', mailBob()));
      expect(hold).toBeInstanceOf(ProactiveHold);
      expect(s.dispatched).toEqual([]);
      expect(await s.cards()).toHaveLength(0);
      expect(await s.pushes()).toHaveLength(0);
    },
  );

  databaseTest('a send that also carries a key is asked about as before', async () => {
    const s = await setup({ routine: 'Every Friday, message Bob the deploy key.' });
    const woke = await s.attempt('background');
    const asked = await woke.propose('test.send_secret', {
      to: 'bob@example.com',
      text: 'Here it is.',
      api_key: 'sk-live-123',
    });
    expect(asked.status).toBe('needs_approval');
    expect(s.dispatched).toEqual([]);
  });

  databaseTest('a similar one the person said no to outweighs the routine', async () => {
    const s = await setup({ routine: 'Every Friday, email Bob the weekly summary.' });
    await s.answered('test.send_email', mailBob('Last week went well.'), 'denied');
    const woke = await s.attempt('background');
    const hold = await rejectionOf(woke.propose('test.send_email', mailBob()));
    expect(hold).toBeInstanceOf(ProactiveHold);
    expect((hold as ProactiveHold).confidence.score).toBe(0.1);
  });

  databaseTest('a recipient Melete cannot vouch for scores nothing', async () => {
    const s = await setup({ routine: 'Every Friday, email the weekly summary to whoever asked.' });
    const woke = await s.attempt('background');
    const hold = await rejectionOf(
      woke.propose('test.send_email', { ...mailBob(), to: 'someone@elsewhere.example' }),
    );
    expect(hold).toBeInstanceOf(ProactiveHold);
    expect((hold as ProactiveHold).confidence.score).toBe(0);
  });

  databaseTest(
    'with messages to others kept as drafts, a message is left as a suggestion, even when asked for',
    async () => {
      // What would be enough on confidence alone is not, once messages start as drafts.
      const s = await setup({ messagesToOthers: 'draft_only' });
      await s.remember('I always message Bob when I am running late.');
      await s.answered('test.send_message', messageBob('Late, sorry.'), 'approved');
      await s.answered('test.send_message', messageBob('Ten minutes behind.'), 'approved');
      const woke = await s.attempt('background');
      const hold = await rejectionOf(woke.propose('test.send_message', messageBob()));
      expect(hold).toBeInstanceOf(ProactiveHold);
      expect((hold as ProactiveHold).confidence.missing.join(' ')).toContain(
        'messages to others are kept as drafts here',
      );
      expect(s.dispatched).toEqual(['test.send_message', 'test.send_message']);

      // The operator's older draft_only keeps them out of proactive work, as it did:
      // only the person choosing a level for messages changes that.
      const asked = await setup({
        routine: 'When I am running late, message Bob.',
        messagesToOthers: 'draft_only',
      });
      expect(
        await rejectionOf(
          (await asked.attempt('background')).propose('test.send_message', messageBob()),
        ),
      ).toBeInstanceOf(ProactiveHold);
      expect(asked.dispatched).toEqual([]);
    },
  );

  databaseTest(
    "a job's own first shift, which nothing woke, is asked about as before",
    async () => {
      const s = await setup({ routine: 'Every Friday, email Bob the weekly summary.' });

      const fresh = await s.firstShift();
      expect((await fresh.propose('test.send_email', mailBob())).status).toBe('needs_approval');
      expect(await s.suggestions()).toHaveLength(0);
    },
  );

  databaseTest('work the person is waiting on is asked about as before', async () => {
    const s = await setup();
    const there = await s.attempt('interactive');
    expect((await there.propose('test.send_email', mailBob())).status).toBe('needs_approval');
    expect(await s.suggestions()).toHaveLength(0);
  });
});
