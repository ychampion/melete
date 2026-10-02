/**
 * Named agents, end to end against Postgres: Melete is in every space and
 * keeps its reach, a conversation goes to Melete unless another agent is
 * chosen, "@Scout …" hands one message to Scout, and each agent's permissions
 * hold where the work crosses into connections, the computer and memory.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { attemptBundle, type DispatchResult, type RuntimeAdapter } from '@melete/contracts';
import { BrokerService } from '../../src/broker/service.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { openDatabase } from '../../src/db/client.ts';
import { agentAccess } from '../../src/experience/access.ts';
import { AGENT_TEMPLATES, MELETE_AGENT } from '../../src/experience/agents.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { captureChat } from '../../src/memory/capture.ts';
import { correctClaim } from '../../src/memory/claims.ts';
import { withMemoryRuntime } from '../../src/memory/context.ts';
import { MemoryError, type MemoryScope } from '../../src/memory/db.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import { buildViews } from '../../src/memory/views.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { PrincipalService } from '../../src/principals/service.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { createJobAttempt, createJournal } from './lifecycle-fixtures.ts';
import { createScope, createTestDatabase } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
const submissions = jobs ? new SubmissionService(jobs) : null;
const experience =
  handle && jobs && submissions ? new ExperienceService(handle.db, jobs, submissions) : null;
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
});
const withDb = db ? describe : describe.skip;

const template = (name: string) => {
  const found = AGENT_TEMPLATES.templates.find((entry) => entry.agent.name === name);
  if (!found) throw new Error(`no ${name} template`);
  return found.agent;
};

/** Insert a specialist straight into the table, with the permissions under test. */
async function specialist(
  spaceId: string,
  values: { uses_computer?: boolean; reads_memory?: boolean; writes_memory?: boolean } = {},
  allowed: string[] | null = null,
) {
  if (!db) throw new Error('no database');
  const id = newId('agent');
  await db.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
      standing_instruction, allowed_connection_ids, uses_computer, reads_memory, writes_memory)
    values (${id}, ${spaceId}, 'Scout', 'Researcher', '#6FA3C7', 'octagon', '#12293A', 'Curious', 'Cite',
      ${allowed === null ? null : JSON.stringify(allowed)}::jsonb, ${values.uses_computer ?? true},
      ${values.reads_memory ?? true}, ${values.writes_memory ?? true})`;
  return id;
}

withDb('Melete, the agent every space has', () => {
  test('is made once per space, listed first, and reaches everything', async () => {
    if (!db || !experience) return;
    const scope = await createScope(db);
    // The migration made one for this space already; asking twice at once makes no second.
    const [first, second] = await Promise.all([
      experience.defaultAgent(scope.spaceId),
      experience.defaultAgent(scope.spaceId),
    ]);
    expect(first.id).toBe(second.id);
    const fresh = newId('sp');
    await db.sql`insert into space (id, name, git_path) values (${fresh}, 'Fresh', ${`test/${fresh}`})`;
    const made = await Promise.all([
      experience.defaultAgent(fresh),
      experience.defaultAgent(fresh),
    ]);
    expect(made[0].id).toBe(made[1].id);
    const [{ count }] =
      (await db.sql`select count(*)::int as count from agent where space_id = ${fresh} and is_default`) as unknown as [
        { count: number },
      ];
    expect(count).toBe(1);

    await experience.saveAgent(scope.spaceId, template('Quill'));
    const { agents } = await experience.agents(scope.spaceId);
    expect(agents.map((agent) => [agent.name, agent.is_default])).toEqual([
      ['Melete', true],
      ['Quill', false],
    ]);
    expect(agents[0]).toMatchObject({
      allowed_connection_ids: null,
      uses_computer: true,
      reads_memory: true,
      writes_memory: true,
    });
  });

  test('keeps its name and reach; only its look and voice change', async () => {
    if (!db || !experience) return;
    const scope = await createScope(db);
    const melete = await experience.defaultAgent(scope.spaceId);
    for (const change of [
      { name: 'Mel' },
      { allowed_connection_ids: [] },
      { uses_computer: false },
      { reads_memory: false },
      { writes_memory: false },
    ])
      expect(
        await rejectionOf(
          experience.saveAgent(scope.spaceId, { ...MELETE_AGENT, ...change }, melete.id),
        ),
      ).toMatchObject({ code: 'default_agent_fixed', status: 400 });
    const saved = await experience.saveAgent(
      scope.spaceId,
      { ...MELETE_AGENT, tone: 'Brisk', colour: '#22459C' },
      melete.id,
    );
    expect(saved.agent).toMatchObject({ name: 'Melete', tone: 'Brisk', is_default: true });
    // A specialist made from the same values is never a second Melete.
    const copy = await experience.saveAgent(scope.spaceId, MELETE_AGENT);
    expect(copy.agent.is_default).toBe(false);
  });

  test('takes a chat or a routine when no agent is named', async () => {
    if (!db || !experience) return;
    const scope = await createScope(db);
    const melete = await experience.defaultAgent(scope.spaceId);
    const created = await principalContext.run(scope.ownerId, () =>
      experience.createConversation(scope.spaceId, { title: 'Weekend' }),
    );
    if (!('conversation' in created)) throw new Error('conversation not created');
    expect(created.conversation.agent_id).toBe(melete.id);
  });

  test('the migration gives an older chat with no agent to Melete', async () => {
    if (!db) return;
    // Every chat in the database has an agent once the migration has run.
    const [orphan] =
      await db.sql`select count(*)::int as count from job where kind in ('chat', 'routine') and agent_id is null`;
    expect(orphan?.count).toBe(0);
  });
});

withDb('a mention hands one message to that agent', () => {
  test('"@Scout …" goes to Scout, the next message to the chat’s agent', async () => {
    if (!db || !experience) return;
    const scope = await createScope(db);
    const melete = await experience.defaultAgent(scope.spaceId);
    const scout = await specialist(scope.spaceId);
    const created = await principalContext.run(scope.ownerId, () =>
      experience.createConversation(scope.spaceId, { title: 'Trip' }),
    );
    if (!('conversation' in created)) throw new Error('conversation not created');
    const id = created.conversation.id;
    const say = async (text: string) => {
      await principalContext.run(scope.ownerId, () =>
        experience.message(scope.spaceId, id, { text }, newId('turn')),
      );
      await db.sql`update job set state = 'waiting_for_input', current_turn_id = null where id = ${id}`;
    };
    await say('@scout find trains to Porto on Friday');
    await say('Thanks. Book the earlier one');
    await say('@Scoutish is not anyone');
    const turns =
      await db.sql`select agent_id from experience_turn where job_id = ${id} order by created_at, id`;
    expect(turns.map((turn) => turn.agent_id)).toEqual([scout, melete.id, melete.id]);
    const [chat] = await db.sql`select agent_id from job where id = ${id}`;
    expect(chat?.agent_id).toBe(melete.id);
  });
});

/**
 * A shared space with its owner and one member, two connections, and helpers
 * to start a chat and send a message as either of them.
 */
async function household() {
  if (!db || !experience) throw new Error('no database');
  const scope = await createScope(db);
  const member = newId('own');
  await db.sql`insert into principal (id, email) values (${member}, ${`${member}@example.test`})`;
  const shared = newId('sp');
  await db.sql`insert into space (id, name, git_path, kind, owner_principal_id)
    values (${shared}, 'Household', ${`test/${shared}`}, 'shared', ${scope.ownerId})`;
  await db.sql`insert into space_membership (principal_id, space_id, role) values
    (${scope.ownerId}, ${shared}, 'owner'), (${member}, ${shared}, 'member')`;
  const narrow = newId('conn');
  const wide = newId('conn');
  for (const id of [narrow, wide])
    await db.sql`insert into connection (id, space_id, provider, label, scopes)
      values (${id}, ${shared}, 'test', ${id}, '["test.read"]'::jsonb)`;
  const service = experience;
  const sql = db.sql;
  const chat = async (who: string, agentId?: string) => {
    const created = await principalContext.run(who, () =>
      service.createConversation(shared, {
        title: 'House',
        ...(agentId ? { agent_id: agentId } : {}),
      }),
    );
    if (!('conversation' in created)) throw new Error('conversation not created');
    return created.conversation;
  };
  const say = async (who: string, id: string, text: string) => {
    await principalContext.run(who, () => service.message(shared, id, { text }, newId('turn')));
    const [turn] =
      await sql`select agent_id from experience_turn where job_id = ${id} order by created_at desc, id desc limit 1`;
    const access = await agentAccess(sql, id);
    await sql`update job set state = 'waiting_for_input', current_turn_id = null where id = ${id}`;
    return { agent: turn?.agent_id, allowed: access.allowed };
  };
  return { owner: scope.ownerId, member, shared, narrow, wide, chat, say };
}

withDb('Melete in a shared space', () => {
  test('reaches nothing until the owner chooses, and only the owner may choose', async () => {
    if (!experience) return;
    const h = await household();
    const service = experience;
    const melete = await service.defaultAgent(h.shared);
    const { agents } = await principalContext.run(h.member, () => service.agents(h.shared));
    expect(agents[0]).toMatchObject({
      id: melete.id,
      is_default: true,
      fixed_reach: false,
      allowed_connection_ids: [],
    });

    // A member's chat goes to Melete and reaches nothing by default.
    const chat = await h.chat(h.member);
    expect(chat.agent_id).toBe(melete.id);
    expect(await h.say(h.member, chat.id, 'What is in the shared inbox?')).toEqual({
      agent: melete.id,
      allowed: [],
    });

    // A member cannot widen it.
    const wider = { ...MELETE_AGENT, allowed_connection_ids: null };
    expect(
      await rejectionOf(
        principalContext.run(h.member, () => service.saveAgent(h.shared, wider, melete.id)),
      ),
    ).toMatchObject({ code: 'scope_denied', status: 403 });

    // The owner grants one connection; the member then reaches only that one.
    const granted = await principalContext.run(h.owner, () =>
      service.saveAgent(
        h.shared,
        { ...MELETE_AGENT, allowed_connection_ids: [h.narrow] },
        melete.id,
      ),
    );
    expect(granted.agent.allowed_connection_ids).toEqual([h.narrow]);
    expect(await h.say(h.member, chat.id, 'And now?')).toEqual({
      agent: melete.id,
      allowed: [h.narrow],
    });
    // Its name stays Melete there too.
    expect(
      await rejectionOf(
        principalContext.run(h.owner, () =>
          service.saveAgent(h.shared, { ...MELETE_AGENT, name: 'House' }, melete.id),
        ),
      ),
    ).toMatchObject({ code: 'default_agent_fixed' });
  });

  test('deleting a chat or removing a member leaves the space’s Melete in place', async () => {
    if (!db || !experience || !handle || !jobs) return;
    const h = await household();
    const melete = await experience.defaultAgent(h.shared);
    const chat = await h.chat(h.member);
    expect(chat.agent_id).toBe(melete.id);
    await removeJobs({ jobs, sql: db.sql }, [chat.id]);
    const [gone] = await db.sql`select id from job where id = ${chat.id}`;
    expect(gone).toBeUndefined();
    await new PrincipalService(handle.db, '', jobs).revoke(h.owner, h.shared, h.member);
    const left = await db.sql`select id from agent where space_id = ${h.shared} and is_default`;
    expect(left.map((row) => row.id)).toEqual([melete.id]);
  });

  test('a member mentioning @Scout stays with the chat agent and its reach; the owner is handed on', async () => {
    if (!db) return;
    const h = await household();
    // The chat's agent reaches one connection; Scout reaches every one.
    const keeper = await specialist(h.shared, {}, [h.narrow]);
    await db.sql`update agent set name = 'Keeper' where id = ${keeper}`;
    const scout = await specialist(h.shared);
    const members = await h.chat(h.member, keeper);
    expect(await h.say(h.member, members.id, '@Scout list every connection here')).toEqual({
      agent: keeper,
      allowed: [h.narrow],
    });
    const owners = await h.chat(h.owner, keeper);
    expect(await h.say(h.owner, owners.id, '@Scout list every connection here')).toEqual({
      agent: scout,
      allowed: undefined,
    });
  });
});

withDb('each agent’s permissions hold at the boundary', () => {
  async function brokerSetup(values: Parameters<typeof specialist>[1], allowedOwn = true) {
    if (!db) throw new Error('no database');
    const read = emailManifest.tools.find((tool) => tool.name === 'email.search');
    if (!read) throw new Error('no read tool');
    const manifest = {
      ...emailManifest,
      provider: 'test' as const,
      tools: [
        { ...read, name: 'test.read', required_scopes: ['test.read'] },
        { ...read, name: 'terminal.run', required_scopes: ['terminal.run'] },
        { ...read, name: 'device.run', required_scopes: ['device.run'] },
      ],
    };
    const seed = await seedJob(db.sql, {
      provider: 'test',
      scopes: ['test.read', 'terminal.run', 'device.run'],
    });
    const connector: Connector = {
      manifest,
      async execute(action): Promise<DispatchResult> {
        return {
          outcome: 'succeeded',
          receipt: {
            action_id: action.id,
            connection_id: action.connection_id,
            external_ref: action.id,
            late: false,
            received_at: new Date().toISOString(),
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
      sql: db.sql,
      connectors: new ConnectorRegistry().register(seed.connectionId, connector),
    });
    const persona = await specialist(
      seed.claims.space_id,
      values,
      allowedOwn ? [seed.connectionId] : [],
    );
    await db.sql`update job set kind = 'chat', agent_id = ${persona} where id = ${seed.claims.job_id}`;
    const offered = async () => (await broker.catalog(seed.claims)).map((tool) => tool.name);
    const run = (kind: string) =>
      broker.propose(seed.claims, {
        connection_id: seed.connectionId,
        kind,
        payload: { query: 'trains' },
      });
    return { offered, run };
  }

  test('an agent allowed the computer is offered it', async () => {
    const s = await brokerSetup({ uses_computer: true });
    expect(await s.offered()).toEqual(
      expect.arrayContaining(['test.read', 'terminal.run', 'device.run']),
    );
  });

  test('an agent kept off the computer is neither offered it nor let use it', async () => {
    const s = await brokerSetup({ uses_computer: false });
    const offered = await s.offered();
    expect(offered).toContain('test.read');
    expect(offered).not.toContain('terminal.run');
    // A paired computer is the computer too.
    expect(offered).not.toContain('device.run');
    expect(await rejectionOf(s.run('terminal.run'))).toMatchObject({ code: 'scope_denied' });
    expect(await rejectionOf(s.run('device.run'))).toMatchObject({ code: 'scope_denied' });
    expect(await s.run('test.read')).toMatchObject({ action_id: expect.any(String) });
  });

  test('an agent without a connection is neither offered it nor let use it', async () => {
    const s = await brokerSetup({}, false);
    expect(await s.offered()).not.toContain('test.read');
    expect(await rejectionOf(s.run('test.read'))).toMatchObject({ code: 'scope_denied' });
  });

  test('an agent set not to read memory is handed none of it', async () => {
    if (!db) return;
    const scope = await createScope(db);
    const committed = await record(
      db,
      scope,
      { identity: 'seat', text: 'Seat aisle on every trip.', eventAt: '2026-09-01T00:00:00Z' },
      [{ key: 'pref.travel.seat', content: 'aisle', quote: 'aisle', kind: 'user_statement' }],
    );
    expect(committed.status).toBe('committed');
    await buildViews(db.sql, scope);
    const handed = async (readsMemory: boolean, corrected = false) => {
      const created = await createJobAttempt(db, scope);
      const jobId = created.jobId;
      const persona = await specialist(scope.spaceId, { reads_memory: readsMemory });
      await db.sql`update job set kind = 'chat', agent_id = ${persona} where id = ${jobId}`;
      if (corrected) {
        // An earlier answer in this chat cited the seat, and the seat was corrected since.
        const seat = await head(db, scope, 'pref.travel.seat');
        if (!seat) throw new Error('no seat claim');
        await recordOutput(db.sql, scope, {
          job_id: jobId,
          attempt_id: null,
          kind: 'plan_step',
          output_id: 'step_1',
          output_version: '1',
          location: 'step 1',
          uses: [`${seat.id}@${seat.head_revision}`],
        });
        await correctClaim(db.sql, scope, {
          claim_id: seat.id,
          expected_revision: seat.head_revision,
          text: 'Window, please.',
          content: 'window',
          valid_from: '2026-09-05T00:00:00Z',
          valid_until: null,
          idempotency_key: `seat-${jobId}`,
        });
      }
      const [current] = await db.sql`select revision, lease_epoch from job where id = ${jobId}`;
      const revision = Number(current?.revision);
      const epoch = Number(current?.lease_epoch);
      // The correction fenced the first attempt, so the next one starts at the current epoch.
      const attemptId = corrected ? newId('att') : created.attemptId;
      if (corrected)
        await db.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
          values (${attemptId}, ${jobId}, ${epoch}, 'scripted-v1', 'fake', 'scripted-memory-v1')`;
      // The knowledge list is emptied once the attempt ends, so it is read while it runs.
      let delivered: { knowledge: string[]; briefs: number } | null = null;
      const runtime: RuntimeAdapter = {
        async capabilities() {
          return { version: 'scripted-v1', tools: false, streaming: true, interrupt: true };
        },
        async start(bundle) {
          delivered = {
            knowledge: bundle.knowledge.map((item) => item.excerpt),
            briefs: bundle.inputs.repair_briefs.length + bundle.since_last.repair_briefs.length,
          };
          return { kind: 'completed', summary: 'Done.', evidence: [] };
        },
      };
      await withMemoryRuntime(runtime, db.sql, async () => scope).start(
        attemptBundle.parse({
          attempt: { id: attemptId, job_id: jobId, epoch, revision, token: 'fixture-only' },
          job: {
            title: 'Trip',
            objective: 'seat for the trip',
            constraints: {},
            progress_summary: '',
            unresolved_questions: [],
            deliverable: {},
          },
          inputs: { new_user_messages: [], approval_results: [], trigger_events: [] },
          transcript: [],
          tools: [],
          skills: [],
          knowledge: [],
          workspace: { mount: '/work', files: [] },
          budget: { max_turns: 1, max_output_tokens: 100, max_wall_ms: 1000, max_actions: 0 },
          model: { provider: 'fake', model: 'scripted-memory-v1', fallback: null },
        }),
        { async emit() {} },
        new AbortController().signal,
      );
      // What the attempt is recorded as having used is what the chat shows as "Used what you told me".
      const [context] =
        await db.sql`select items from memory_contexts where attempt_id = ${attemptId}`;
      const pending =
        await db.sql`select id from memory_repair_briefs where job_id = ${jobId} and state = 'pending'`;
      return {
        ...(delivered as unknown as { knowledge: string[]; briefs: number }),
        used: (context?.items as unknown[] | undefined)?.length ?? 0,
        pending: pending.length,
      };
    };
    const reads = await handed(true);
    expect(reads.knowledge.join()).toContain('aisle');
    expect(reads.used).toBeGreaterThan(0);
    // Nothing is recalled, recorded as used or briefed; the correction stays pending.
    expect(await handed(false, true)).toEqual({ knowledge: [], briefs: 0, used: 0, pending: 1 });
  });

  test('an agent set not to keep memory keeps nothing said to it', async () => {
    if (!db || !experience) return;
    const scope = await createScope(db);
    const owner: MemoryScope = { ...scope, principalId: scope.ownerId };
    const journal = await createJournal();
    const quiet = await specialist(scope.spaceId, { writes_memory: false });
    const created = await principalContext.run(scope.ownerId, () =>
      experience.createConversation(scope.spaceId, { title: 'Notes' }),
    );
    if (!('conversation' in created)) throw new Error('conversation not created');
    const id = created.conversation.id;
    const say = async (text: string) => {
      await principalContext.run(scope.ownerId, () =>
        experience.message(scope.spaceId, id, { text }, newId('turn')),
      );
      await db.sql`update job set state = 'waiting_for_input', current_turn_id = null where id = ${id}`;
    };
    try {
      await say('@Scout I prefer a window seat');
      await say('I prefer an aisle seat');
      await captureChat({
        privacyOrigin: async () => null,
        sql: db.sql,
        journal: journal.journal,
        scopeForJob: async (jobId) => {
          const [job] = await db.sql`select space_id from job where id = ${jobId}`;
          if (job?.space_id !== scope.spaceId) throw new MemoryError('scope_denied');
          return owner;
        },
      });
      const outcomes = await db.sql`select c.outcome, e.payload->>'agent_id' as agent_id
        from memory_capture c join event e on e.seq = c.event_seq
        where c.job_id = ${id} order by c.event_seq`;
      expect(outcomes[0]).toMatchObject({ outcome: 'skipped:agent', agent_id: quiet });
      expect(outcomes[1]?.outcome).not.toMatch(/^skipped/);
    } finally {
      await journal.close();
    }
  });
});
