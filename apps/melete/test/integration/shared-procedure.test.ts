import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { attemptOutcome } from '@melete/contracts';
import {
  gradeRecords,
  type RecordCase,
  taskObjective,
} from '../../../../conformance/learning/records.ts';
import { ScriptedRecordRuntime } from '../../../../conformance/learning/scripted-runtime.ts';
import { loadEnv } from '../../src/env.ts';
import { createScriptedProvider, fakeProvider } from '../../src/gateway/fake.ts';
import { createApp } from '../../src/index.ts';
import { withCapability } from '../../src/jobs/fence.ts';
import { ProcedureEvaluator } from '../../src/learning/evaluator.ts';
import { openProposalGateway } from '../../src/learning/proposal-gateway.ts';
import { ProcedureProposer } from '../../src/learning/proposer.ts';
import { selectProcedureSkills } from '../../src/learning/selection.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { learningFixture, learningScope, wake } from './learning-fixtures.ts';

const runtime = new ScriptedRecordRuntime();
const fixture = await learningFixture(runtime);
const temp = await realpath(tmpdir());
const root = await mkdtemp(join(temp, 'melete-shared-procedure-'));
const gateway = fixture
  ? await openProposalGateway({
      db: fixture.handle.db,
      provider: 'fake',
      model: 'scripted-proposer-v1',
      providers: [fakeProvider],
      fake: (body, id, protocol) =>
        createScriptedProvider([
          {
            text: JSON.stringify({
              target: 'skill_body',
              steps: ['sort-typed-values', 'keep-header-and-rows'],
              test: 'ordering-and-shape',
            }),
          },
        ])(body, id, protocol),
    })
  : null;
afterAll(async () => {
  await gateway?.close();
  await fixture?.close();
  if (dirname(resolve(root)) !== temp || (await realpath(root)) !== resolve(root))
    throw new Error('Unverified shared procedure fixture directory');
  await rm(root, { recursive: true, force: true });
}, 30_000);
const training: RecordCase = {
  template: 'shared-training',
  task: {
    columns: ['id', 'date'],
    rows: [
      { id: 'a', date: '19/11/2028' },
      { id: 'b', date: '04/01/2028' },
      { id: 'c', date: '10/05/2028' },
    ],
    key: 'date',
    type: 'date',
    dateFormat: 'dmy',
    direction: 'ascending',
  },
  expectedIds: ['b', 'c', 'a'],
};
const later: RecordCase = {
  template: 'shared-renewals',
  task: {
    columns: ['id', 'due'],
    rows: [
      { id: 'x', due: '12/06/2030' },
      { id: 'y', due: '01/02/2030' },
      { id: 'z', due: '20/12/2030' },
    ],
    key: 'due',
    type: 'date',
    dateFormat: 'dmy',
    direction: 'ascending',
  },
  expectedIds: ['y', 'x', 'z'],
};

(fixture ? test : test.skip)(
  'an owner promotes an evaluated procedure for a different authorized principal',
  async () => {
    if (!fixture || !gateway) throw new Error('Postgres unavailable');
    const proposer = new ProcedureProposer(fixture.jobs, gateway);
    const evaluator = new ProcedureEvaluator(fixture.jobs, runtime, fixture.runner.options);
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
      db: fixture.handle.db,
      sql: fixture.handle.sql,
      jobs: fixture.jobs,
      runner: fixture.runner,
      episodes: fixture.episodes,
      proposer,
      evaluator,
      checkDatabase: async () => 'ok',
    });
    const password = 'shared-procedure-password';
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    await fixture.handle
      .sql`update owner set password_hash = ${passwordHash}, email = 'shared-owner@example.test' where id = ${fixture.ownerId}`;
    await fixture.handle
      .sql`update principal set password_hash = ${passwordHash}, email = 'shared-owner@example.test' where id = ${fixture.ownerId}`;
    const send = (
      path: string,
      token = '',
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
    ) =>
      app.request(path, {
        method,
        headers: { cookie: token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    async function json<T>(response: Response, status = 200): Promise<T> {
      const body = await response.json();
      expect({ status: response.status, ...(response.status !== status ? { body } : {}) }).toEqual({
        status,
      });
      return body as T;
    }
    const login = await send('/login', '', { email: 'shared-owner@example.test', password });
    const ownerCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(ownerCookie).not.toBe('');
    const shared = await json<{ space: { id: string } }>(
      await send('/spaces/shared', ownerCookie, { name: 'Evaluated shared work' }),
      201,
    );
    const spaceId = shared.space.id;
    const member = await json<{ principal: { id: string } }>(
      await send('/principals', ownerCookie, { email: 'shared-reader@example.test', password }),
      201,
    );
    await json(
      await send(`/spaces/${spaceId}/memberships`, ownerCookie, {
        principal_id: member.principal.id,
      }),
      201,
    );
    const memberLogin = await send('/login', '', { email: 'shared-reader@example.test', password });
    const memberCookie = memberLogin.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(memberCookie).not.toBe('');
    async function create(token: string, item: RecordCase) {
      const response = await json<{ job: { id: string } }>(
        await send('/jobs', token, {
          space_id: spaceId,
          title: item.template,
          objective: taskObjective(item.task),
          learning: { scope: learningScope, template_id: item.template, input_refs: [] },
        }),
        201,
      );
      return response.job.id;
    }
    async function run(id: string) {
      if (!fixture) throw new Error('Postgres unavailable');
      await fixture.runner.handleWake(wake(await fixture.jobs.get(id)));
      const [attempt] = await fixture.handle
        .sql`select outcome_detail from attempt where job_id = ${id} order by epoch desc limit 1`;
      const outcome = attemptOutcome.parse(attempt?.outcome_detail);
      expect(outcome.kind).toBe('completed');
      if (outcome.kind !== 'completed') throw new Error('The runtime did not complete');
      return outcome.summary;
    }
    const original = await create(ownerCookie, training);
    expect(gradeRecords(training, await run(original))).toBe(false);
    const correction = await json<{ episode: { id: string; correctiveJobId: string } }>(
      await send(`/jobs/${original}/interventions`, ownerCookie, {
        idempotency_key: 'shared-private-correction',
        kind: 'correction',
        signal: 'typed_ordering',
        text: 'PRIVATE-PRINCIPAL-A-76392: use typed chronological ordering and preserve every input row.',
      }),
      201,
    );
    expect(gradeRecords(training, await run(correction.episode.correctiveJobId))).toBe(true);
    const proposed = await json<{ candidate: { id: string } }>(
      await send(`/episodes/${correction.episode.id}/propose`, ownerCookie, { space_id: spaceId }),
      201,
    );
    const id = proposed.candidate.id;
    await json(await send(`/procedures/${id}/evaluate`, ownerCookie, { space_id: spaceId }));
    const canary = await json<{
      candidate: { promotion: { scope: string; principal_id: string } };
    }>(await send(`/procedures/${id}/canary`, ownerCookie, { space_id: spaceId }));
    expect(canary.candidate.promotion).toEqual({ scope: 'private', principal_id: fixture.ownerId });
    const ownCanary = await create(ownerCookie, { ...later, template: 'owner-private-canary' });
    expect(gradeRecords(later, await run(ownCanary))).toBe(true);
    const privateTask = await create(memberCookie, { ...later, template: 'member-before-sharing' });
    expect(gradeRecords(later, await run(privateTask))).toBe(false);
    expect(
      runtime.observed.find((bundle) => bundle.attempt.job_id === privateTask)?.skills,
    ).toEqual([]);
    const episodes = await json<{ episodes: { jobId: string }[] }>(
      await send(`/episodes?space_id=${spaceId}`, ownerCookie),
    );
    expect(episodes.episodes.map((episode) => episode.jobId)).not.toContain(privateTask);
    expect((await send(`/procedures/${id}?space_id=${spaceId}`, memberCookie)).status).toBe(403);
    expect(
      (
        await send(`/procedures/${id}/activate`, memberCookie, {
          space_id: spaceId,
          scope: 'space',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(`/procedures/${id}/activate`, ownerCookie, {
          space_id: spaceId,
          scope: 'space',
          principal_id: member.principal.id,
        })
      ).status,
    ).toBe(400);
    const promoted = await send(`/procedures/${id}/activate`, ownerCookie, {
      space_id: spaceId,
      scope: 'space',
    });
    expect(promoted.status).toBe(200);
    const published = (await promoted.json()) as {
      candidate: { promotion: { scope: string; principal_id: string } };
    };
    expect(published.candidate.promotion).toEqual({
      scope: 'space',
      principal_id: fixture.ownerId,
    });
    const teammate = await create(memberCookie, later);
    expect(gradeRecords(later, await run(teammate))).toBe(true);
    const bundle = runtime.observed.find((bundle) => bundle.attempt.job_id === teammate);
    expect(bundle?.skills.map((skill) => skill.name)).toContain(`procedure:${id}`);
    expect(JSON.stringify(bundle)).not.toContain('PRIVATE-PRINCIPAL-A-76392');
    expect(bundle?.skills.find((skill) => skill.name === `procedure:${id}`)?.space_id).toBe(
      spaceId,
    );
    const publicJob = await json<{ job: { id: string } }>(
      await send('/jobs', memberCookie, {
        space_id: spaceId,
        title: 'Public task',
        objective: taskObjective(later.task),
        constraints: { public_compartment: true },
        learning: { scope: learningScope, template_id: 'public-scope', input_refs: [] },
      }),
      201,
    );
    await run(publicJob.job.id);
    expect(
      runtime.observed
        .find((entry) => entry.attempt.job_id === publicJob.job.id)
        ?.skills.map((skill) => skill.name),
    ).not.toContain(`procedure:${id}`);
    const other = await json<{ space: { id: string } }>(
      await send('/spaces/shared', ownerCookie, { name: 'Other boundary' }),
      201,
    );
    await json(
      await send(`/spaces/${other.space.id}/memberships`, ownerCookie, {
        principal_id: member.principal.id,
      }),
      201,
    );
    const outside = await json<{ job: { id: string } }>(
      await send('/jobs', memberCookie, {
        space_id: other.space.id,
        title: 'Other space',
        objective: taskObjective(later.task),
        learning: { scope: learningScope, template_id: 'outside-origin-space', input_refs: [] },
      }),
      201,
    );
    await run(outside.job.id);
    expect(
      runtime.observed
        .find((entry) => entry.attempt.job_id === outside.job.id)
        ?.skills.map((skill) => skill.name),
    ).not.toContain(`procedure:${id}`);
    const live = await create(memberCookie, { ...later, template: 'member-live-before-revoke' });
    const claim = await fixture.runner.claim(wake(await fixture.jobs.get(live)));
    expect(claim?.bundle.skills.map((skill) => skill.name)).toContain(`procedure:${id}`);
    if (!claim) throw new Error('Expected the authorized principal claim');
    const queued = await create(memberCookie, {
      ...later,
      template: 'member-queued-before-revoke',
    });
    const delivered = runtime.observed.length;
    await json(
      await send(
        `/spaces/${spaceId}/memberships/${member.principal.id}`,
        ownerCookie,
        undefined,
        'DELETE',
      ),
    );
    expect((await fixture.jobs.get(queued)).state).toBe('cancelled');
    expect(await fixture.runner.claim(wake(await fixture.jobs.get(queued)))).toBeNull();
    expect(runtime.observed).toHaveLength(delivered);
    let dispatched = 0;
    await rejectionOf(
      withCapability(
        fixture.jobs,
        claim.bundle.attempt.token,
        fixture.runner.options.key,
        async () => {
          dispatched++;
        },
      ),
    );
    expect(dispatched).toBe(0);
    const former = await fixture.jobs.get(teammate);
    expect(
      await rejectionOf(
        fixture.jobs.transaction((tx) =>
          selectProcedureSkills(
            tx,
            former,
            { provider: 'fake', model: 'scripted-learning-v1', fallback: null },
            'scripted-records/1',
          ),
        ),
      ),
    ).toMatchObject({ code: 'scope_denied' });
    expect(
      (
        await send('/jobs', memberCookie, {
          space_id: spaceId,
          title: 'Revoked',
          objective: taskObjective(later.task),
        })
      ).status,
    ).toBe(403);
    await json(
      await send(`/procedures/${id}/rollback`, ownerCookie, {
        space_id: spaceId,
        reason: 'End shared promotion test',
      }),
    );
    const after = await create(ownerCookie, { ...later, template: 'owner-after-shared-rollback' });
    await run(after);
    expect(
      runtime.observed
        .find((entry) => entry.attempt.job_id === after)
        ?.skills.map((skill) => skill.name),
    ).not.toContain(`procedure:${id}`);
  },
  120_000,
);
