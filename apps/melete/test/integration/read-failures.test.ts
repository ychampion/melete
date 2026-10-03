/**
 * A read that fails is a failed read. Listing a folder a new space has not made
 * yet, reading a file that is not there or a lookup that errors must come back
 * to the model with a reason, and must never leave an effect "unknown" or ask
 * anyone to reconcile something that changed nothing. (A write that fails
 * the same untyped way still rests unknown; `repair.test.ts` holds that.)
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConnectorManifest } from '@melete/contracts';
import { appendEvent, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { newId } from '../../src/ids.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;
const roots: string[] = [];
/** Files a test puts in its job's workspace once the job exists. */
const pictures: ((jobId: string) => Promise<void>)[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await fixture?.close();
}, 15_000);

/** A lookup that fails every call with an error nobody typed. */
function failingLookup(message: string): Connector {
  const manifest: ConnectorManifest = {
    name: 'test',
    version: '0.1.0',
    provider: 'test',
    description: 'A destination that fails without saying how.',
    credentials: [],
    health: true,
    tools: [
      {
        name: 'test.lookup',
        description: 'Fails every time.',
        input_schema: { type: 'object', additionalProperties: true },
        effect_class: 'read',
        required_scopes: [],
        verify: false,
        requires_approval: false,
      },
    ],
  };
  return {
    manifest,
    async execute() {
      throw new Error(message);
    },
    async verify() {
      return { decision: 'unsupported', reason: 'nothing to verify' };
    },
    async health() {
      return { status: 'ok', detail: 'fixture', checked_at: new Date().toISOString() };
    },
  };
}

async function setup(
  scopes: string[],
  provider: string,
  connector: (roots: { workRoot: string; spacesRoot: string }) => Connector,
) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const seed = await seedJob(sql, { scopes, provider });
  const root = await mkdtemp(path.join(tmpdir(), 'melete-reads-'));
  roots.push(root);
  // A fresh install: the roots exist, and nothing inside them for this space or job.
  const workRoot = path.join(root, 'work');
  const spacesRoot = path.join(root, 'spaces');
  await mkdir(workRoot);
  await mkdir(spacesRoot);
  const registry = new ConnectorRegistry().register(
    seed.connectionId,
    connector({ workRoot, spacesRoot }),
  );
  return { ...seed, sql, broker: new BrokerService({ sql, connectors: registry }) };
}

async function standing(sql: NonNullable<typeof fixture>['sql'], jobId: string) {
  const [job] = await sql`select state from job where id = ${jobId}`;
  const [questions] =
    await sql`select count(*)::int as count from question where job_id = ${jobId} and state = 'open'`;
  return { state: job?.state, questions: questions?.count };
}

databaseTest(
  'listing and reading what a new space has not made yet is an answer, not an unknown',
  async () => {
    const ctx = await setup(['files.list', 'files.read'], 'files', (roots) =>
      createFilesConnector(roots),
    );
    const empty = await ctx.broker.propose(ctx.claims, {
      kind: 'files.list',
      connection_id: ctx.connectionId,
      payload: { area: 'artifacts', path: '.' },
    });
    expect(empty.status).toBe('succeeded');
    for (const payload of [{ path: 'memory' }, { path: 'sources' }]) {
      const missing = await ctx.broker.propose(ctx.claims, {
        kind: 'files.list',
        connection_id: ctx.connectionId,
        payload,
      });
      expect(missing.status).toBe('failed');
      expect(missing.message).toContain(`there is no folder "${payload.path}" in work`);
    }
    const unread = await ctx.broker.propose(ctx.claims, {
      kind: 'files.read',
      connection_id: ctx.connectionId,
      payload: { path: 'plans/dentist.md' },
    });
    expect(unread.status).toBe('failed');
    expect(unread.message).toContain('there is no file "plans/dentist.md" in work');
    // The job carries on, and nobody is asked about a lookup.
    expect(await standing(ctx.sql, ctx.claims.job_id)).toEqual({ state: 'running', questions: 0 });
    const actions = await ctx.sql`select status from action where job_id = ${ctx.claims.job_id}`;
    expect(actions.map((row) => row.status).sort()).toEqual([
      'failed',
      'failed',
      'failed',
      'succeeded',
    ]);
  },
  SLOW,
);

databaseTest(
  'an untyped failure of a lookup fails with its reason and leaves the job running',
  async () => {
    const ctx = await setup(['test.lookup'], 'test', () =>
      failingLookup('upstream answered HTTP 503 for /var/lib/melete/cache/prices.json'),
    );
    const result = await ctx.broker.propose(ctx.claims, {
      kind: 'test.lookup',
      connection_id: ctx.connectionId,
      payload: { q: 'bitcoin price' },
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('upstream answered HTTP 503 for <path>');
    expect(result.message).not.toContain('/var/lib');
    expect(await standing(ctx.sql, ctx.claims.job_id)).toEqual({ state: 'running', questions: 0 });
  },
  SLOW,
);

databaseTest(
  'reading a picture says plainly why there is no text, and the read is settled at once',
  async () => {
    const ctx = await setup(['files.read'], 'files', (roots) => {
      // A PNG as a paired computer's screenshot leaves it: NUL bytes and all.
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff,
      ]);
      pictures.push(async (jobId: string) => {
        await mkdir(path.join(roots.workRoot, jobId, 'device'), { recursive: true });
        await writeFile(path.join(roots.workRoot, jobId, 'device', 'screenshot-1.png'), png);
      });
      return createFilesConnector(roots);
    });
    for (const write of pictures.splice(0)) await write(ctx.claims.job_id);
    const read = await ctx.broker.propose(ctx.claims, {
      kind: 'files.read',
      connection_id: ctx.connectionId,
      payload: { path: 'device/screenshot-1.png' },
    });
    // The read settles with no content and a sentence saying why; no bytes go back.
    expect(read.status).toBe('succeeded');
    expect(await standing(ctx.sql, ctx.claims.job_id)).toEqual({ state: 'running', questions: 0 });
    const actions =
      await ctx.sql`select status, receipt from action where job_id = ${ctx.claims.job_id}`;
    expect(actions.map((row) => row.status)).toEqual(['succeeded']);
    const detail =
      (actions[0]?.receipt as { detail?: Record<string, unknown> } | undefined)?.detail ?? {};
    expect(detail.content).toBeNull();
    expect(String(detail.note)).toContain('is a picture of 17 bytes');
  },
  SLOW,
);

databaseTest(
  'a read left without an answer is failed, never unknown, and nobody is asked about it',
  async () => {
    const ctx = await setup(['test.lookup'], 'test', () => failingLookup('unused'));
    const insert = async (status: 'dispatched' | 'unknown') => {
      const id = newId('act');
      await ctx.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status, dispatched_at)
        values (${id}, ${ctx.claims.job_id}, ${ctx.claims.attempt_id}, ${ctx.connectionId},
          'test.lookup', 'read', '{}'::jsonb, ${'d'.repeat(64)}, ${id}, ${status}, now())`;
      return id;
    };
    // The tool call ended before the read reported back.
    const abandoned = await insert('dispatched');
    expect(await ctx.broker.settleAbandoned(ctx.claims.attempt_id)).toBe(1);
    // A read that an earlier version left unknown is settled by recovery.
    const stuck = await insert('unknown');
    await ctx.broker.recoverDispatched();
    const rows = await ctx.sql`select id, status, reconciliation from action
      where id = any(${[abandoned, stuck]}) order by id`;
    for (const row of rows) {
      expect(row.status).toBe('failed');
      expect((row.reconciliation as { retryable: boolean }).retryable).toBe(true);
    }
    expect(await standing(ctx.sql, ctx.claims.job_id)).toEqual({ state: 'running', questions: 0 });
  },
  SLOW,
);

/** A read left unknown by an earlier version, with the question it raised still open. */
async function leftUnknown(ctx: Awaited<ReturnType<typeof setup>>) {
  const id = newId('act');
  await ctx.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
      canonical_payload, payload_hash, idempotency_key, status, dispatched_at)
    values (${id}, ${ctx.claims.job_id}, ${ctx.claims.attempt_id}, ${ctx.connectionId},
      'test.lookup', 'read', '{}'::jsonb, ${'c'.repeat(64)}, ${id}, 'unknown', now())`;
  const questionId = recordId('qst');
  await ctx.sql.begin(async (tx) => {
    await tx`insert into question
        (id, source, job_id, attempt_id, text, because, if_ignored, blocks_external_effect)
      values (${questionId}, 'job', ${ctx.claims.job_id}, ${ctx.claims.attempt_id},
        'Did it arrive?', '["It never answered."]'::jsonb, 'It waits.', true)`;
    await appendEvent(tx, ctx.claims.job_id, ctx.claims.attempt_id, 'notice', {
      action_id: id,
      phase: 'repair_escalated',
      disposition: 'needs_reconciliation',
      question_id: questionId,
    });
  });
  return { id, questionId };
}

databaseTest(
  'settling a read left unknown withdraws the question it raised, in the same pass',
  async () => {
    const ctx = await setup(['test.lookup'], 'test', () => failingLookup('unused'));
    const { id, questionId } = await leftUnknown(ctx);
    await ctx.broker.recoverDispatched();
    const [action] = await ctx.sql`select status from action where id = ${id}`;
    expect(action?.status).toBe('failed');
    const [question] = await ctx.sql`select state from question where id = ${questionId}`;
    expect(question?.state).toBe('withdrawn');
    const [closed] = await ctx.sql`select payload from event
      where job_id = ${ctx.claims.job_id} and payload->>'kind' = 'question_closed'`;
    expect(closed?.payload).toMatchObject({ question_id: questionId, reason: 'read_settled' });
  },
  SLOW,
);

databaseTest(
  'an MCP tool its policy calls a read is still asked about unless its server says it is read-only',
  async () => {
    for (const declared of [false, true]) {
      const ctx = await setup(['test.lookup'], 'mcp', () => ({
        ...failingLookup('unused'),
        catalog: { source: 'mcp' as const },
        readOnlyDeclared: (kind: string) => declared && kind === 'test.lookup',
      }));
      const { id, questionId } = await leftUnknown(ctx);
      await ctx.broker.recoverDispatched();
      // A call the tool never answered: settled only when the server vouches for it.
      const abandoned = newId('act');
      await ctx.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status, dispatched_at)
        values (${abandoned}, ${ctx.claims.job_id}, ${ctx.claims.attempt_id}, ${ctx.connectionId},
          'test.lookup', 'read', '{"q":1}'::jsonb, ${'b'.repeat(64)}, ${abandoned}, 'dispatched', now())`;
      await ctx.broker.settleAbandoned(ctx.claims.attempt_id);
      const rows = await ctx.sql`select id, status from action where id = any(${[id, abandoned]})`;
      const statuses = Object.fromEntries(rows.map((row) => [row.id, row.status]));
      const [question] = await ctx.sql`select state from question where id = ${questionId}`;
      if (declared) {
        expect(statuses).toEqual({ [id]: 'failed', [abandoned]: 'failed' });
        expect(question?.state).toBe('withdrawn');
      } else {
        expect(statuses).toEqual({ [id]: 'unknown', [abandoned]: 'unknown' });
        expect(question?.state).toBe('open');
      }
    }
  },
  SLOW,
);
