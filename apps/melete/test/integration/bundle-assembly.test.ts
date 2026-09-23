import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptBundle } from '@melete/contracts';
import { META_TOOLS } from '../../src/broker/catalog.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { REACT_TOOL } from '../../src/connectors/catalog.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { newId } from '../../src/ids.ts';
import { buildBundle } from '../../src/jobs/bundle.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { correctClaim } from '../../src/memory/claims.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';
import { createScope } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 30_000);

(handle && queue ? describe : describe.skip)('bundle assembly', () => {
  test('three selected skills, two handled claims and durable briefs stay in their space', async () => {
    if (!handle || !queue) return;
    const db = { ...handle, boss: queue.boss };
    const a = await createScope(db);
    const b = await createScope(db);
    const root = await mkdtemp(join(tmpdir(), 'melete-bundle-assembly-'));
    const skills = join(root, a.spaceId, 'skills');
    await mkdir(skills, { recursive: true });
    await handle.sql`update space set git_path = ${join(root, a.spaceId)} where id = ${a.spaceId}`;
    for (const name of ['alpha', 'beta', 'gamma', 'zeta'])
      await writeFile(
        join(skills, `${name}.md`),
        `---\nname: ${name}\ndescription: Local trip procedure\ntriggers: [travel]\ntools: []\n---\nUse the ${name} trip procedure.`,
      );
    const committed = await record(
      db,
      a,
      {
        identity: 'trip',
        text: 'trip seat aisle and trip meal vegan',
        eventAt: '2026-09-01T00:00:00Z',
      },
      [
        { key: 'pref.travel.seat', content: 'aisle', quote: 'aisle', kind: 'user_statement' },
        { key: 'pref.travel.meal', content: 'vegan', quote: 'vegan', kind: 'user_statement' },
      ],
    );
    expect(committed.status).toBe('committed');
    const connectionId = newId('conn');
    await handle.sql`insert into connection (id, space_id, provider, label, scopes, status)
      values (${connectionId}, ${a.spaceId}, 'test', 'Test', '["test.send"]'::jsonb, 'active')`;
    const registry = await configuredConnectors({
      sql: handle.sql,
      workRoot: root,
      spacesRoot: root,
      enableTestConnector: true,
    });
    const broker = new BrokerService({ sql: handle.sql, connectors: registry });
    const jobs = new JobService(handle.db, queue.boss);
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'bundle-assembly-signing-key-32-chars',
      scopes: ['test.send'],
    });
    const bundles = [];
    for (const scope of [a, b]) {
      const job = await jobs.create({
        space_id: scope.spaceId,
        title: 'Trip',
        objective: 'travel',
      });
      const claim = await runner.claim({
        job_id: job.id,
        expected_epoch: job.leaseEpoch,
        expected_version: job.stateVersion,
        reason: 'created',
      });
      if (!claim) throw new Error('attempt was not claimed');
      const built = await buildBundle(claim.bundle, {
        sql: handle.sql,
        scope,
        catalog: () => broker.catalog(claim.claims),
      });
      expect(attemptBundle.safeParse(built.bundle).success).toBe(true);
      bundles.push(built.bundle);
    }
    const [first, other] = bundles;
    if (!first || !other) throw new Error('missing bundle');
    expect(first.skills.map((skill) => skill.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(first.knowledge).toHaveLength(2);
    expect(first.knowledge.every((item) => /@1$/.test(item.handle ?? ''))).toBe(true);
    // The broker catalog leads with discovery and the reaction tool; the granted connector follows.
    expect(first.tools.map((tool) => tool.name)).toEqual([
      'search_tools',
      'load_tool',
      'react',
      'test.send',
    ]);
    // One delta, completed with the memory sources the lease could not see.
    expect(first.inputs.since_last).toBeUndefined();
    expect(first.since_last.evidence.map((item) => item.kind)).toEqual(['source']);
    expect(other.skills).toEqual([]);
    expect(other.knowledge).toEqual([]);
    expect(other.tools).toEqual([...META_TOOLS, REACT_TOOL]);
    expect(other.since_last.evidence).toEqual([]);
    const seat = await head(db, a, 'pref.travel.seat');
    if (!seat) throw new Error('missing seat');
    await recordOutput(handle.sql, a, {
      job_id: first.attempt.job_id,
      attempt_id: null,
      kind: 'plan_step',
      output_id: 'trip-plan',
      output_version: '1',
      location: 'seat',
      uses: [`${seat.id}@1`],
    });
    await correctClaim(handle.sql, a, {
      claim_id: seat.id,
      expected_revision: 1,
      text: 'trip seat window',
      content: 'window',
      valid_from: '2026-09-05T00:00:00Z',
      valid_until: null,
      idempotency_key: 'window',
    });
    const repaired = await buildBundle(first, {
      sql: handle.sql,
      scope: a,
      catalog: async () => [],
    });
    expect(repaired.bundle.inputs.repair_briefs[0]?.changed_handle).toBe(`${seat.id}@1`);
    expect(repaired.bundle.inputs.repair_briefs[0]?.replacement_handle).toBe(`${seat.id}@2`);
  }, 20_000);

  test("a job's output budget above the window leaves the attempt the whole window for input", async () => {
    if (!handle || !queue) return;
    const scope = await createScope({ ...handle, boss: queue.boss });
    const jobs = new JobService(handle.db, queue.boss);
    // The runner's default model has no catalog entry: a 128,000-token window.
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'bundle-assembly-signing-key-32-chars',
      scopes: [],
    });
    const job = await jobs.create({
      space_id: scope.spaceId,
      title: 'Long report',
      objective: 'Write the long report',
      budget: { max_output_tokens: 250_000 },
    });
    const claim = await runner.claim({
      job_id: job.id,
      expected_epoch: job.leaseEpoch,
      expected_version: job.stateVersion,
      reason: 'created',
    });
    if (!claim) throw new Error('attempt was not claimed');
    expect(claim.claims.budget.max_output_tokens).toBe(250_000);
    expect(claim.claims.budget.max_input_tokens).toBe(128_000);
    expect(claim.bundle.budget.max_output_tokens).toBe(250_000);
    expect(claim.bundle.budget.max_input_tokens).toBe(128_000);
  });
});
