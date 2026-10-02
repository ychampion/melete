import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  activityList,
  agentResponse,
  conversationDeleted,
  conversationList,
  conversationResponse,
  dedupKey,
  planList,
  planResponse,
  spaceMembers,
} from '@melete/contracts';
import { eq, inArray } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import {
  action,
  approval,
  artifact,
  attempt,
  connection,
  experienceTurn,
  job,
  owner,
  principal,
  space,
  spaceMembership,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { publishRevision } from '../../src/memory/claims.ts';
import { lockSpace, type MemoryScope, provisionMemorySpace } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const journalled: RestrictionRecord[] = [];
const journal: RestrictionJournal = {
  read: async () => journalled,
  append: async (record) => {
    journalled.push(record);
  },
};
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'tidy-up-fixture-signing-key-32-bytes-long',
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      memory: { sql: handle.sql, journal },
      checkDatabase: async () => 'ok',
    })
  : null;
const ownerId = newId('own');
const memberId = newId('own');
const spaceId = newId('sp');
const sharedId = newId('sp');
const token = (principalId: string | null, chosen: string, generation: number | null) => {
  const value = randomBytes(32).toString('base64url');
  return {
    value,
    row: {
      tokenHash: createHash('sha256').update(value).digest('hex'),
      ownerId,
      principalId,
      spaceId: chosen,
      membershipGeneration: generation,
      expiresAt: new Date(Date.now() + 600000),
    },
  };
};
const personal = token(null, spaceId, null);
const ownerShared = token(ownerId, sharedId, 0);
const memberShared = token(memberId, sharedId, 0);
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'tidy@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db.insert(principal).values({ id: memberId, email: 'guest@example.test' });
  await handle.db.insert(space).values([
    { id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}`, ownerPrincipalId: ownerId },
    {
      id: sharedId,
      name: 'Household',
      kind: 'shared',
      audience: 'space',
      ownerPrincipalId: ownerId,
      gitPath: `/spaces/${sharedId}`,
    },
  ]);
  await handle.db.insert(spaceMembership).values([
    { principalId: ownerId, spaceId: sharedId, role: 'owner' },
    { principalId: memberId, spaceId: sharedId, role: 'member' },
  ]);
  await handle.db.insert(session).values([personal.row, ownerShared.row, memberShared.row]);
}
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Postgres unavailable');
  return value;
}
async function call(path: string, method = 'GET', body?: unknown, as = personal.value) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${as}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
let agents = 0;
async function makeAgent(as = personal.value) {
  // Two agents in a space never share a name.
  const template = AGENT_TEMPLATES.templates[0]?.agent;
  const body = template ? { ...template, name: `${template.name} ${++agents}` } : undefined;
  const response = await call('/agents', 'POST', body, as);
  expect(response.status).toBe(200);
  return agentResponse.parse(await response.json()).agent;
}
async function makeChat(title: string, as = personal.value) {
  const agentId = (await makeAgent(as === memberShared.value ? ownerShared.value : as)).id;
  const created = await call('/conversations', 'POST', { title, agent_id: agentId }, as);
  expect(created.status).toBe(200);
  return conversationResponse.parse(await created.json()).conversation;
}
async function listed() {
  const page = conversationList.parse(await (await call('/conversations')).json());
  return page.conversations.map((chat) => chat.id);
}
/** A chat mid-turn: the message accepted, an attempt claimed and streaming. */
async function runningChat(title: string) {
  const chat = await makeChat(title);
  expect(
    (await call(`/conversations/${chat.id}/messages`, 'POST', { text: 'Book a table for two' }))
      .status,
  ).toBe(200);
  const row = await required(jobs).get(chat.id);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
  await required(runner).emit(claimed.claims, {
    type: 'text_delta',
    text: 'Looking for a table.',
    attempt_id: claimed.claims.attempt_id,
    local_seq: 0,
    dedup_key: dedupKey(claimed.claims.attempt_id, 0),
    at: new Date().toISOString(),
  });
  return { chat, claims: claimed.claims };
}
/** Something Melete learned from a message in this chat, as automatic capture records it. */
async function learnedFrom(chatId: string, text: string, key: string) {
  const sql = required(handle).sql;
  const scope: MemoryScope = {
    ownerId,
    spaceId,
    publisher: 'experience',
    audience: 'private',
    role: 'owner',
  };
  await provisionMemorySpace(sql, ownerId, spaceId);
  await sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
  const source = await ingest(sql, scope, {
    stream: 'chat',
    source_identity: `event:${key}`,
    source_version: '1',
    source_type: 'message',
    author: 'owner',
    event_at: new Date().toISOString(),
    text,
  });
  const claim = await sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    return publishRevision(tx, scope, key, null, {
      key,
      content: text,
      kind: 'preference',
      factual_status: 'attributed',
      protected: false,
      valid_from: new Date().toISOString(),
      valid_until: null,
      sources: [
        { source_id: source.source.source_id, source_version: '1', start: 0, end: text.length },
      ],
    });
  });
  const [seq] = await sql`select coalesce(max(event_seq), 0) + 1000 as next from memory_capture`;
  await sql`insert into memory_capture (event_seq, job_id, space_id, outcome, source_id)
    values (${Number(seq?.next)}, ${chatId}, ${spaceId}, 'remembered', ${source.source.source_id})`;
  return claim.claim_id;
}
async function visible(claimId: string) {
  const [row] = await required(handle).sql`select hidden from memory_claims where id = ${claimId}`;
  return row ? !row.hidden : false;
}

withDb('renaming and deleting chats and plans, and removing people', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a rename changes the title and keeps the chat where it was in the list', async () => {
    const chat = await makeChat('Untitled');
    const renamed = await call(`/conversations/${chat.id}`, 'PATCH', { title: 'Anniversary' });
    expect(renamed.status).toBe(200);
    const view = conversationResponse.parse(await renamed.json()).conversation;
    expect(view.title).toBe('Anniversary');
    expect(view.updated_at).toBe(chat.updated_at);
    expect((await call(`/conversations/${chat.id}`, 'PATCH', { title: '   ' })).status).toBe(400);
    expect((await call('/conversations/job_missing', 'PATCH', { title: 'x' })).status).toBe(404);
  });

  test('deleting a chat mid-turn stops it, withdraws its permission, cancels it and keeps memory', async () => {
    const db = required(handle).db;
    const { chat, claims } = await runningChat('Dinner on Friday');
    const connectionId = newId('conn');
    await db
      .insert(connection)
      .values({ id: connectionId, spaceId, label: 'Mail', provider: 'imap' });
    const actionId = newId('act');
    await db.insert(action).values({
      id: actionId,
      jobId: chat.id,
      attemptId: claims.attempt_id,
      connectionId,
      kind: 'email.send',
      effectClass: 'write_external',
      canonicalPayload: { to: ['sam@example.test'], subject: 'Friday', body: 'Table for two?' },
      payloadHash: 'c'.repeat(64),
      idempotencyKey: actionId,
      status: 'needs_approval',
    });
    const approvalId = newId('apr');
    await db
      .insert(approval)
      .values({ id: approvalId, actionId, jobRevision: 1, payloadHash: 'c'.repeat(64) });
    // A message the chat already sent: it stays on record after the chat goes.
    const sentId = newId('act');
    await db.insert(action).values({
      id: sentId,
      jobId: chat.id,
      attemptId: claims.attempt_id,
      connectionId,
      kind: 'email.send',
      effectClass: 'write_external',
      canonicalPayload: {
        to: ['ana@example.test'],
        subject: 'SECRET_SUBJECT',
        body: 'SECRET_BODY',
      },
      payloadHash: 'e'.repeat(64),
      idempotencyKey: sentId,
      status: 'succeeded',
      receipt: { external_ref: 'msg-4411' },
      resolvedAt: new Date('2026-10-01T09:00:00Z'),
    });
    // A file the chat made stays in the space.
    const fileId = newId('art');
    await db.insert(artifact).values({
      id: fileId,
      spaceId,
      jobId: chat.id,
      sourceJobId: chat.id,
      path: 'menu.md',
      contentHash: 'd'.repeat(64),
      mime: 'text/markdown',
      size: 10,
    });
    const claimId = await learnedFrom(chat.id, 'I like window seats.', 'pref.seat.window');
    const decided: string[] = [];
    const before = required(jobs).onCancelled;
    required(jobs).onCancelled = (id) => {
      decided.push(id);
      before?.(id);
    };
    try {
      const response = await call(`/conversations/${chat.id}`, 'DELETE');
      expect(response.status).toBe(200);
      const outcome = conversationDeleted.parse(await response.json());
      expect(outcome).toEqual({ id: chat.id, stopped: true, withdrawn: 1, forgotten: 0 });
    } finally {
      required(jobs).onCancelled = before;
    }
    expect(decided).toContain(chat.id);
    // The fence moved: the attempt can write nothing more.
    let refused = false;
    try {
      await required(runner).emit(claims, {
        type: 'text_delta',
        text: 'Too late.',
        attempt_id: claims.attempt_id,
        local_seq: 1,
        dedup_key: dedupKey(claims.attempt_id, 1),
        at: new Date().toISOString(),
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(await db.select().from(job).where(eq(job.id, chat.id))).toEqual([]);
    expect(await db.select().from(experienceTurn).where(eq(experienceTurn.jobId, chat.id))).toEqual(
      [],
    );
    expect(await db.select().from(attempt).where(eq(attempt.jobId, chat.id))).toEqual([]);
    expect(await db.select().from(approval).where(eq(approval.id, approvalId))).toEqual([]);
    expect(await listed()).not.toContain(chat.id);
    expect((await call(`/conversations/${chat.id}`)).status).toBe(404);
    const [file] = await db.select().from(artifact).where(eq(artifact.id, fileId));
    expect(file?.jobId).toBeNull();
    // Memory is the person's: deleting the chat did not take what it taught.
    expect(await visible(claimId)).toBe(true);
    expect(journalled.some((record) => record.operation === 'delete')).toBe(false);
    expect((await call(`/conversations/${chat.id}`, 'DELETE')).status).toBe(404);
    // What it did in the person's name is still on record, without what it said.
    const activity = activityList.parse(await (await call('/activity')).json()).activity;
    const sent = activity.find((entry) => entry.source === 'Dinner on Friday');
    expect(sent).toEqual({
      id: expect.any(String),
      what: 'Sent a message',
      where: 'Mail',
      destination: 'ana@example.test',
      reference: 'msg-4411',
      outcome: 'succeeded',
      source: 'Dinner on Friday',
      happened_at: '2026-10-01T09:00:00.000Z',
    });
    expect(JSON.stringify(activity)).not.toContain('SECRET');
    expect(
      activity.some((entry) => entry.reference === null && entry.what === 'Sent a message'),
    ).toBe(false);
  });

  test('a chat with something still being sent is not deleted until it settles', async () => {
    const db = required(handle).db;
    const { chat, claims } = await runningChat('Invoice reply');
    const connectionId = newId('conn');
    await db
      .insert(connection)
      .values({ id: connectionId, spaceId, label: 'Mail', provider: 'imap' });
    const actionId = newId('act');
    await db.insert(action).values({
      id: actionId,
      jobId: chat.id,
      attemptId: claims.attempt_id,
      connectionId,
      kind: 'email.send',
      effectClass: 'write_external',
      canonicalPayload: { to: ['billing@example.test'], subject: 'Invoice', body: 'Paid.' },
      payloadHash: 'f'.repeat(64),
      idempotencyKey: actionId,
      status: 'dispatched',
      dispatchedAt: new Date(),
    });
    const refused = await call(`/conversations/${chat.id}`, 'DELETE');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
      'Something is still being sent. Try again in a moment.',
    );
    // Nothing went: the chat, its turn and the send are all still there.
    expect(await listed()).toContain(chat.id);
    const [kept] = await db.select().from(action).where(eq(action.id, actionId));
    expect(kept?.status).toBe('dispatched');
    // An effect whose outcome is unknown holds it too, with its own reason.
    await db.update(action).set({ status: 'unknown' }).where(eq(action.id, actionId));
    const unclear = await call(`/conversations/${chat.id}`, 'DELETE');
    expect(unclear.status).toBe(409);
    expect(((await unclear.json()) as { error: { code: string } }).error.code).toBe(
      'outcome_unclear',
    );
    // Once it settles, the chat goes and the send stays on record.
    await db
      .update(action)
      .set({ status: 'succeeded', receipt: { external_ref: 'msg-9' }, resolvedAt: new Date() })
      .where(eq(action.id, actionId));
    expect((await call(`/conversations/${chat.id}`, 'DELETE')).status).toBe(200);
    expect(await listed()).not.toContain(chat.id);
    const activity = activityList.parse(await (await call('/activity')).json()).activity;
    expect(activity.find((entry) => entry.reference === 'msg-9')?.destination).toBe(
      'billing@example.test',
    );
  });

  test('deleting a chat takes every memory record that names it, a cited output included', async () => {
    const sql = required(handle).sql;
    const chat = await makeChat('Cited by memory');
    await provisionMemorySpace(sql, ownerId, spaceId);
    const attemptId = newId('att');
    const outputRow = `mout_${randomBytes(8).toString('hex')}`;
    // One row in every memory table that names a job, as an attempt leaves them.
    const seeded: Record<string, () => Promise<unknown>> = {
      memory_outputs: () => sql`insert into memory_outputs (id, space_id, job_id, attempt_id, kind,
          output_id, output_version, attributed)
        values (${outputRow}, ${spaceId}, ${chat.id}, ${attemptId}, 'artifact',
          ${`art_${randomBytes(8).toString('hex')}`}, '1', true)`,
      memory_contexts: () => sql`insert into memory_contexts (id, space_id, job_id, attempt_id,
          job_revision, policy_generation, data_revision, access_generation, audience, purpose,
          items, recipe, token_budget, recall_status)
        values (${`mctx_${randomBytes(8).toString('hex')}`}, ${spaceId}, ${chat.id}, ${attemptId},
          0, 0, 0, 0, '{}'::jsonb, 'attempt', '[]'::jsonb, 'r1', '{}'::jsonb, 'ok')`,
      memory_prepared: () => sql`insert into memory_prepared (id, space_id, job_id, kind, items,
          data_revision)
        values (${`mprep_${randomBytes(8).toString('hex')}`}, ${spaceId}, ${chat.id}, 'brief',
          '[]'::jsonb, 0)`,
      memory_action_basis: () => sql`insert into memory_action_basis (action_id, space_id, job_id,
          attempt_id, items)
        values (${newId('act')}, ${spaceId}, ${chat.id}, ${attemptId}, '[]'::jsonb)`,
      memory_repair_briefs: () => sql`insert into memory_repair_briefs (id, space_id, job_id,
          changed_handle, old_value, new_value, affected)
        values (${`mrep_${randomBytes(8).toString('hex')}`}, ${spaceId}, ${chat.id}, 'c@1',
          'before', 'after', '[]'::jsonb)`,
      memory_invalidations: () => sql`insert into memory_invalidations (id, space_id, type, job_id,
          claim_ids, data_revision)
        values (${`minv_${randomBytes(8).toString('hex')}`}, ${spaceId}, 'correction', ${chat.id},
          '[]'::jsonb, 0)`,
      memory_capture: async () => {
        const [seq] =
          await sql`select coalesce(max(event_seq), 0) + 1000 as next from memory_capture`;
        await sql`insert into memory_capture (event_seq, job_id, space_id, outcome)
          values (${Number(seq?.next)}, ${chat.id}, ${spaceId}, 'skipped')`;
      },
    };
    // Every memory table with a job column is seeded here, so a new one has to
    // be thought about for deletion before this passes.
    const named = await sql`select table_name from information_schema.columns
      where table_schema = 'public' and table_name like 'memory\_%' and column_name = 'job_id'`;
    expect(named.map((row) => String(row.table_name)).sort()).toEqual(Object.keys(seeded).sort());
    for (const insert of Object.values(seeded)) await insert();
    // The output's manifest names the output row: this is what made the delete fail.
    await sql`insert into memory_output_uses (output_row_id, handle, handle_kind, claim_id, revision)
      values (${outputRow}, 'c@1', 'claim', 'clm_cited', 1)`;

    const response = await call(`/conversations/${chat.id}`, 'DELETE');
    expect(response.status).toBe(200);
    expect(await listed()).not.toContain(chat.id);
    for (const table of Object.keys(seeded).filter((name) => name !== 'memory_capture')) {
      const [left] =
        await sql`select count(*)::int as n from ${sql(table)} where job_id = ${chat.id}`;
      expect([table, left?.n]).toEqual([table, 0]);
    }
    const [uses] =
      await sql`select count(*)::int as n from memory_output_uses where output_row_id = ${outputRow}`;
    expect(uses?.n).toBe(0);
    // The capture log stays, no longer naming the chat.
    const [capture] =
      await sql`select count(*)::int as n from memory_capture where job_id = ${chat.id}`;
    expect(capture?.n).toBe(0);
  });

  test('a running command holds a delete, and the refusal says so', async () => {
    const db = required(handle).db;
    const { chat, claims } = await runningChat('Long command');
    const connectionId = newId('conn');
    await db
      .insert(connection)
      .values({ id: connectionId, spaceId, label: 'Computer', provider: 'sandbox' });
    const actionId = newId('act');
    await db.insert(action).values({
      id: actionId,
      jobId: chat.id,
      attemptId: claims.attempt_id,
      connectionId,
      kind: 'terminal.run',
      effectClass: 'write_reversible',
      canonicalPayload: { command: 'sleep 50' },
      payloadHash: '1'.repeat(64),
      idempotencyKey: actionId,
      status: 'dispatched',
      dispatchedAt: new Date(),
    });
    const refused = await call(`/conversations/${chat.id}`, 'DELETE');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: {
        code: 'still_sending',
        message: 'A command is still running. Try again when it finishes.',
      },
    });
    expect(await listed()).toContain(chat.id);
    await db
      .update(action)
      .set({ status: 'succeeded', resolvedAt: new Date() })
      .where(eq(action.id, actionId));
    expect((await call(`/conversations/${chat.id}`, 'DELETE')).status).toBe(200);
  });

  test('asked to, deleting a chat also forgets what it taught, through source deletion', async () => {
    const chat = await makeChat('Allergies');
    const claimId = await learnedFrom(chat.id, 'I am allergic to peanuts.', 'pref.food.allergy');
    const other = await makeChat('Unrelated');
    const kept = await learnedFrom(other.id, 'I prefer mornings.', 'pref.time.morning');
    const response = await call(`/conversations/${chat.id}?forget_memory=true`, 'DELETE');
    expect(response.status).toBe(200);
    expect(conversationDeleted.parse(await response.json())).toMatchObject({
      id: chat.id,
      stopped: false,
      forgotten: 1,
    });
    expect(await visible(claimId)).toBe(false);
    expect(await visible(kept)).toBe(true);
    expect(
      journalled.some((record) => record.operation === 'delete' && record.targets.length === 1),
    ).toBe(true);
    expect(await listed()).not.toContain(chat.id);
    expect(await listed()).toContain(other.id);
  });

  test('deleting a plan takes its steps and keeps the chats started from it', async () => {
    const agentId = (await makeAgent()).id;
    const created = await call('/plans', 'POST', {
      title: 'Move flats',
      category: 'Home',
      milestones: [
        { title: 'Book the van', assignee: { kind: 'agent', agent_id: agentId } },
        { title: 'Pack the books', assignee: { kind: 'person' } },
      ],
    });
    expect(created.status).toBe(200);
    const plan = planResponse.parse(await created.json()).plan;
    const linked = conversationResponse.parse(
      await (await call(`/plans/${plan.id}/conversation`, 'POST', { agent_id: agentId })).json(),
    ).conversation;
    const steps = await required(handle)
      .db.select({ id: job.id })
      .from(job)
      .where(eq(job.planId, plan.id));
    const stepIds = steps.map((step) => step.id).filter((id) => id !== linked.id);
    expect(stepIds).toHaveLength(1);
    const response = await call(`/plans/${plan.id}`, 'DELETE');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    const plans = planList.parse(await (await call('/plans')).json()).plans;
    expect(plans.map((entry) => entry.id)).not.toContain(plan.id);
    expect(
      await required(handle)
        .db.select()
        .from(job)
        .where(inArray(job.id, [plan.id, ...stepIds])),
    ).toEqual([]);
    const chat = conversationResponse.parse(
      await (await call(`/conversations/${linked.id}`)).json(),
    ).conversation;
    expect(chat.plan_id).toBeNull();
    expect((await call(`/plans/${plan.id}`, 'DELETE')).status).toBe(404);
  });

  test('the owner removes a member: their access ends, their work stops and stays in the space', async () => {
    const before = spaceMembers.parse(
      await (await call('/space/members', 'GET', undefined, ownerShared.value)).json(),
    );
    expect(before.space).toMatchObject({ id: sharedId, kind: 'shared', role: 'owner' });
    expect(before.members.map((member) => [member.email, member.role, member.you])).toEqual([
      ['tidy@example.test', 'owner', true],
      ['guest@example.test', 'member', false],
    ]);
    const theirs = await makeChat('Groceries', memberShared.value);
    expect((await required(jobs).get(theirs.id)).principalId).toBe(memberId);
    // A turn of theirs under way.
    const turnId = newId('turn');
    await required(handle)
      .sql`insert into experience_turn (id, job_id, agent_id, submission_id, text, status)
      values (${turnId}, ${theirs.id}, ${theirs.agent_id}, ${`sub_${turnId}`}, 'Order milk', 'working')`;
    await required(handle)
      .sql`update job set current_turn_id = ${turnId}, state = 'running' where id = ${theirs.id}`;
    // A member cannot remove anyone, the owner included.
    expect(
      (await call(`/space/members/${ownerId}`, 'DELETE', undefined, memberShared.value)).status,
    ).toBe(403);
    const removed = await call(
      `/space/members/${memberId}`,
      'DELETE',
      undefined,
      ownerShared.value,
    );
    expect(removed.status).toBe(200);
    // Their session no longer reaches the space: it falls back to their own.
    const after = spaceMembers.parse(
      await (await call('/space/members', 'GET', undefined, memberShared.value)).json(),
    );
    expect(after.space.id).not.toBe(sharedId);
    expect(after.space.kind).toBe('personal');
    expect(
      (await call(`/conversations/${theirs.id}`, 'GET', undefined, memberShared.value)).status,
    ).toBe(404);
    // What they made is still the space's, and no longer running.
    const row = await required(jobs).get(theirs.id);
    expect(row.spaceId).toBe(sharedId);
    expect(row.state).toBe('cancelled');
    const [turn] = await required(handle)
      .db.select()
      .from(experienceTurn)
      .where(eq(experienceTurn.id, turnId));
    expect(turn?.status).toBe('stopped');
    const owners = spaceMembers.parse(
      await (await call('/space/members', 'GET', undefined, ownerShared.value)).json(),
    );
    expect(owners.members.map((member) => member.email)).toEqual(['tidy@example.test']);
  });
});
