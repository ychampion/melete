import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptBundle,
  EMPTY_SINCE_LAST,
  type EventSink,
  type KnowledgeExcerpt,
  type RuntimeAdapter,
} from '@melete/contracts';
import { commitRecord, loadSpace, openIndex, retract, serializeRecord } from '@melete/knowledge';
import { aRecord } from '../../../../packages/knowledge/src/fixtures.ts';
import { testDatabase } from '../../test/helpers/database.ts';
import { newId } from '../ids.ts';
import { startQueue } from '../jobs/queue.ts';
import { databaseSpaces } from '../knowledge/spaces.ts';
import { startDeploymentMemory } from '../memory/bootstrap.ts';
import { listClaims } from '../memory/claims.ts';
import { ingest } from '../memory/evidence.ts';
import { forgetMemory } from '../memory/forget.ts';
import { runExtractionWork } from '../memory/service.ts';
import { buildViews } from '../memory/views.ts';
import { withDeploymentContext } from './context.ts';

const parent = await testDatabase();
afterAll(async () => parent?.close());
const withDb = parent ? describe : describe.skip;

async function fixture() {
  const handle = await testDatabase();
  if (!handle) throw new Error('Postgres unavailable');
  const root = await mkdtemp(join(tmpdir(), 'melete-w6-context-'));
  const queue = await startQueue(handle.url);
  const memory = await startDeploymentMemory({
    sql: handle.sql,
    boss: queue.boss,
    restrictionsDir: join(root, 'restrictions'),
    workers: false,
  });
  const ownerId = newId('own');
  const spaceId = newId('sp');
  const spacesRoot = join(root, 'spaces');
  await handle.sql`insert into owner (id, email) values (${ownerId}, 'context@example.test')`;
  await handle.sql`insert into space (id, name, git_path)
    values (${spaceId}, 'Context', ${join(spacesRoot, spaceId)})`;
  const spaces = databaseSpaces(handle.db, spacesRoot);
  const ref = await spaces.byId(spaceId);
  if (!ref) throw new Error('Catalog space unavailable');
  const snapshots: KnowledgeExcerpt[][] = [];
  const raw: RuntimeAdapter = {
    capabilities: async () => ({
      version: 'context-fixture',
      tools: false,
      streaming: true,
      interrupt: true,
    }),
    async start(bundle, sink) {
      snapshots.push(structuredClone(bundle.knowledge));
      await sink.emit({
        type: 'turn_started',
        attempt_id: bundle.attempt.id,
        local_seq: 0,
        dedup_key: `${bundle.attempt.id}:0`,
        at: new Date().toISOString(),
        turn: 0,
      });
      return { kind: 'completed', summary: 'Read current context', evidence: [] };
    },
  };
  const options = { sql: handle.sql, spaces, scopeForJob: memory.scopeForJob };
  const sink: EventSink = {
    async emit(event) {
      const [attempt] =
        await handle.sql`select job_id, epoch from attempt where id = ${event.attempt_id}`;
      await handle.sql`insert into event (job_id, attempt_id, epoch, type, payload, dedup_key)
        values (${attempt?.job_id}, ${event.attempt_id}, ${attempt?.epoch}, ${event.type},
          ${JSON.stringify(event)}::text::jsonb, ${event.dedup_key})`;
    },
  };
  const makeAttempt = async (
    objective: string,
    constraints: Record<string, unknown> = {},
    jobId?: string,
  ) => {
    const id = jobId ?? newId('job');
    if (!jobId)
      await handle.sql`insert into job (id, space_id, title, objective, state, revision, lease_epoch, constraints)
      values (${id}, ${spaceId}, 'Context', ${objective}, 'running', 1, 0, ${JSON.stringify(constraints)}::text::jsonb)`;
    await handle.sql`update attempt set ended_at = clock_timestamp(), outcome = 'completed'
      where job_id = ${id} and ended_at is null`;
    const [row] = await handle.sql`update job set lease_epoch = lease_epoch + 1, state = 'running'
      where id = ${id} returning lease_epoch, revision, constraints`;
    const attemptId = newId('att');
    await handle.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attemptId}, ${id}, ${row?.lease_epoch}, 'context-fixture', 'fake', 'scripted')`;
    const bundle: AttemptBundle = {
      attempt: {
        id: attemptId,
        job_id: id,
        epoch: row?.lease_epoch,
        revision: row?.revision,
        token: 'fixture-only',
      },
      job: {
        title: 'Context',
        objective,
        constraints: row?.constraints,
        progress_summary: '',
        unresolved_questions: [],
        deliverable: {},
      },
      since_last: EMPTY_SINCE_LAST,
      inputs: {
        new_user_messages: [],
        approval_results: [],
        trigger_events: [],
        repair_briefs: [],
      },
      transcript: [],
      tools: [],
      skills: [],
      knowledge: [],
      workspace: { mount: '/work', files: [] },
      budget: { max_turns: 2, max_output_tokens: 100, max_wall_ms: 10000, max_actions: 0 },
      model: { provider: 'fake', model: 'scripted', fallback: null },
    };
    return bundle;
  };
  return {
    ...handle,
    queue,
    root,
    spaceId,
    ref,
    memory,
    raw,
    options,
    sink,
    snapshots,
    makeAttempt,
    adapter: withDeploymentContext(raw, options),
    async record(marker: string, id = newId('k'), path = `knowledge/${id}.md`) {
      await commitRecord(
        ref.paths,
        path,
        serializeRecord(aRecord({ id, space: ref.name, title: marker }), marker),
        {
          proposedBy: 'owner',
          subject: 'Prepare context fixture',
        },
      );
      return { id, path };
    },
    async claim(bundle: AttemptBundle) {
      const scope = await memory.scopeForJob(bundle.attempt.job_id);
      const accepted = await ingest(handle.sql, scope, {
        stream: 'contacts',
        source_identity: 'clinic',
        source_version: '1',
        source_type: 'observation',
        event_at: '2026-09-11T00:00:00Z',
        text: JSON.stringify({ kind: 'contact', slug: 'clinic', email: 'clinic@example.test' }),
      });
      const [work] =
        await handle.sql`select id from memory_work where source_id = ${accepted.source.source_id}`;
      await runExtractionWork(
        { sql: handle.sql, boss: queue.boss, journal: memory.routes.journal },
        String(work?.id),
      );
      await buildViews(handle.sql, scope);
      const claim = (await listClaims(handle.sql, scope)).claims[0];
      if (!claim) throw new Error('Positive claim missing');
      return { claim, scope };
    },
    async close() {
      await memory.close();
      await queue.stop();
      await handle.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

withDb('deployment attempt context', () => {
  test('first-job provisioning reads actual Markdown then excludes retraction on the next attempt', async () => {
    const f = await fixture();
    try {
      const record = await f.record('contextmarker');
      const first = await f.makeAttempt('contextmarker');
      expect(await f.sql`select space_id from memory_spaces`).toHaveLength(0);
      await f.adapter.start(first, f.sink, new AbortController().signal);
      expect(f.snapshots[0]?.map((item) => item.provenance.id)).toContain(record.id);
      expect(f.snapshots[0]?.[0]?.origin_trust).toBe('external_content');
      expect(f.snapshots[0]?.[0]?.handle).toBeUndefined();
      const loaded = loadSpace(f.ref.paths).records.find(
        (item) => item.frontmatter.id === record.id,
      );
      if (!loaded) throw new Error('Written record missing');
      const { index } = openIndex(f.ref.paths);
      try {
        await retract(f.ref.paths, index, loaded, { reason: 'No longer true', by: 'owner' });
      } finally {
        index.close();
      }
      const next = await f.makeAttempt('contextmarker', {}, first.attempt.job_id);
      await f.adapter.start(next, f.sink, new AbortController().signal);
      expect(f.snapshots[1]?.map((item) => item.provenance.id)).not.toContain(record.id);
      const notices = await f.sql`select payload from event where type = 'notice' order by seq`;
      expect(notices.map((row) => row.payload.record_ids)).toEqual([[record.id], []]);
      expect(await f.sql`select seq from event where type = 'turn_started'`).toHaveLength(2);
      await expect(f.memory.scopeForJob(newId('job'))).rejects.toThrow('scope_denied');
    } finally {
      await f.close();
    }
  });

  test('stale memory inspection files cannot reintroduce a forgotten Postgres claim as legacy text', async () => {
    const f = await fixture();
    try {
      const first = await f.makeAttempt('clinic');
      const { claim, scope } = await f.claim(first);
      await f.record('clinic stale claim', claim.id);
      const derived = await f.record('clinic stale derived view');
      await f.sql`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${f.spaceId}, 'claim', ${claim.id}, '1', 'markdown', ${derived.path}, 'old')`;
      const ordinary = await f.record('clinic independent document');
      await forgetMemory(f.sql, scope, { claim_id: claim.id }, f.memory.routes.journal);
      const next = await f.makeAttempt('clinic', {}, first.attempt.job_id);
      await f.adapter.start(next, f.sink, new AbortController().signal);
      expect(f.snapshots[0]?.map((item) => item.provenance.id)).toEqual([ordinary.id]);
    } finally {
      await f.close();
    }
  });

  test('the public compartment receives neither owner memory nor owner Markdown', async () => {
    const f = await fixture();
    try {
      const bundle = await f.makeAttempt('clinic', { public_compartment: true });
      await f.claim(bundle);
      await f.record('clinic private document');
      bundle.job.constraints = {}; // The durable constraint must win.
      await f.adapter.start(bundle, f.sink, new AbortController().signal);
      expect(f.snapshots).toEqual([[]]);
      const [context] =
        await f.sql`select audience from memory_contexts where attempt_id = ${bundle.attempt.id}`;
      expect(context?.audience).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test('memory invalidation aborts and clears the same array after legacy context is appended', async () => {
    const f = await fixture();
    try {
      const bundle = await f.makeAttempt('clinic');
      const { claim, scope } = await f.claim(bundle);
      const legacy = await f.record('clinic independent document');
      const adapter = withDeploymentContext(
        {
          capabilities: f.raw.capabilities,
          async start(prepared, _sink, signal) {
            expect(prepared.knowledge.some((item) => item.handle)).toBe(true);
            expect(prepared.knowledge.map((item) => item.provenance.id)).toContain(legacy.id);
            await forgetMemory(f.sql, scope, { claim_id: claim.id }, f.memory.routes.journal);
            expect(signal.aborted).toBe(true);
            expect(prepared.knowledge).toHaveLength(0);
            return { kind: 'completed', summary: 'This stale completion must fail', evidence: [] };
          },
        },
        f.options,
      );
      await expect(adapter.start(bundle, f.sink, new AbortController().signal)).rejects.toThrow(
        'context_invalidated',
      );
    } finally {
      await f.close();
    }
  });

  test('context is byte-bounded and stale caller epochs cannot launch or create a selection audit', async () => {
    const f = await fixture();
    try {
      for (let index = 0; index < 10; index++)
        await f.record(`bounded ${'description '.repeat(12)}${index}`);
      const longObjective = 'bounded '.repeat(400);
      const bundle = await f.makeAttempt(longObjective);
      await f.adapter.start(bundle, f.sink, new AbortController().signal);
      expect(Buffer.byteLength(JSON.stringify(f.snapshots[0]))).toBeLessThanOrEqual(2000);
      expect(f.snapshots[0]?.length).toBeGreaterThan(0);
      expect(f.snapshots[0]?.length).toBeLessThan(10);
      const stale = await f.makeAttempt('bounded');
      stale.attempt.epoch += 1;
      await expect(f.adapter.start(stale, f.sink, new AbortController().signal)).rejects.toThrow(
        'stale_attempt',
      );
      expect(
        await f.sql`select seq from event where attempt_id = ${stale.attempt.id}`,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
