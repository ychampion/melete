import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type AttemptBundle, attemptOutcome, procedureScope } from '@melete/contracts';
import {
  gradeRecords,
  type RecordCase,
  taskObjective,
} from '../../../../conformance/learning/records.ts';
import { verifyCapability } from '../../src/broker/capability.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { bootstrap } from '../../src/index.ts';
import { EVALUATED_SCOPE } from '../../src/learning/evaluator.ts';
import { selectedContext } from '../../src/principals/context.ts';
import { capabilityProvider } from '../fixtures/capability-provider.ts';
import { testDatabase } from '../helpers/database.ts';
import { record } from './properties-fixtures.ts';

const enabled =
  process.env.MELETE_CAPABILITY_PROOF === '1' || process.env.MELETE_CAPABILITY_AUDIT === '1';
const proof = enabled ? test : test.skip;
const KEY = 'w14-proof-capability-key-at-least-32';
const PRIVATE = 'OWNER-PRIVATE-CORRECTION-76392';
const training: RecordCase = {
  template: 'w14-owner-dates',
  task: {
    columns: ['id', 'date'],
    rows: [
      { id: 'a', date: '15/12/2026' },
      { id: 'b', date: '02/03/2026' },
      { id: 'c', date: '11/01/2026' },
    ],
    key: 'date',
    type: 'date',
    dateFormat: 'dmy',
    direction: 'ascending',
  },
  expectedIds: ['c', 'b', 'a'],
};
const later: RecordCase = {
  template: 'w14-renewal-dates',
  task: {
    columns: ['id', 'due'],
    rows: [
      { id: 'x', due: '22/11/2028' },
      { id: 'y', due: '01/01/2028' },
      { id: 'z', due: '17/06/2028' },
      { id: 'w', due: '01/04/2028' },
    ],
    key: 'due',
    type: 'date',
    dateFormat: 'dmy',
    direction: 'ascending',
  },
  expectedIds: ['y', 'w', 'z', 'x'],
};

/** Audit mode verifies available seams; proof mode additionally requires every requested capability. */
proof(
  'real Hermes capability chain: discovery, hooks, learning, teammate context and revocation',
  async () => {
    expect(existsSync(loadEnv({}).MELETE_HERMES_PYTHON)).toBe(true);
    const handle = await testDatabase();
    if (!handle) throw new Error('The capability proof requires Postgres');
    const root = await mkdtemp(join(await realpath(tmpdir()), 'melete-w14-capability-'));
    const spaces = join(root, 'spaces');
    const evidence: Record<string, unknown> = {
      engine: 'hermes@v2026.9.7',
      provider: 'fake',
      missing: [],
      stages: {},
    };
    const gaps = evidence.missing as string[];
    let installationProbe: { status: number; body: string; jobState: string } | undefined;
    const stages = evidence.stages as Record<string, unknown>;
    const failures: string[] = [];
    const provider = capabilityProvider();
    const bundles: AttemptBundle[] = [];
    let calls = 0;
    let connected = true;
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    let api: ReturnType<typeof Bun.serve> | undefined;
    // This is the implemented operator-file HTTP transport, not a substitute for the missing stdio route.
    const mcp = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!connected) return new Response('fixture disconnected', { status: 503 });
        if (request.method === 'DELETE') return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result: unknown = {};
        if (message.method === 'initialize')
          result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
        if (message.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'read',
                description: 'Read capability fixture',
                inputSchema: { type: 'object', additionalProperties: false },
              },
            ],
          };
        if (message.method === 'tools/call') {
          calls++;
          result = { content: [{ type: 'text', text: 'fixture-value-verified' }] };
        }
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      },
    });
    const connectionId = newId('conn');
    const serverConfig = {
      id: 'fixture',
      endpoint: { transport: 'http', url: `${mcp.url}mcp` },
      allowed_scopes: ['mcp_fixture.read'],
      audience: 'owner',
      tools: [
        {
          name: 'read',
          alias: 'read',
          required_scopes: ['mcp_fixture.read'],
          effect_class: 'read',
        },
      ],
    };
    const configPath = join(root, 'connections.json');
    await writeFile(
      configPath,
      JSON.stringify([{ kind: 'mcp', id: connectionId, server: serverConfig }]),
    );
    let cookie = '';
    const call = (
      path: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
      as = cookie,
      spaceId?: string,
    ) =>
      fetch(`http://127.0.0.1:3160${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          cookie: as,
          ...(spaceId ? { 'x-melete-space': spaceId } : {}),
          'Idempotency-Key': crypto.randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    async function json<T>(response: Response, status = 200): Promise<T> {
      const body = await response.json();
      if (response.status !== status)
        throw new Error(`HTTP ${response.status}, expected ${status}: ${JSON.stringify(body)}`);
      return body as T;
    }
    async function stage(name: string, work: () => Promise<unknown>) {
      if (
        process.env.MELETE_CAPABILITY_STAGE &&
        !name.startsWith(process.env.MELETE_CAPABILITY_STAGE)
      )
        return;
      try {
        stages[name] = { status: 'passed', detail: await work() };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${detail}`);
        stages[name] = { status: 'failed', detail };
      }
      process.stdout.write(`W14 capability ${name}: ${JSON.stringify(stages[name])}\n`);
    }
    async function create(
      spaceId: string,
      title: string,
      objective: string,
      as = cookie,
      learning = false,
    ) {
      const body = await json<{ job: { id: string } }>(
        await call(
          '/jobs',
          {
            space_id: spaceId,
            title,
            objective,
            budget: { max_wall_ms: 120000, max_turns: 10, max_attempts: 1 },
            ...(learning
              ? { learning: { scope: EVALUATED_SCOPE, template_id: title, input_refs: [] } }
              : {}),
          },
          'POST',
          as,
        ),
        201,
      );
      return body.job.id;
    }
    async function run(id: string) {
      if (!handle) throw new Error('Missing database');
      if (!service?.jobs || !service.runner) throw new Error('Missing runner');
      const row = await service.jobs.get(id);
      await service.runner.handleWake({
        job_id: id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      });
      const deadline = Date.now() + 135000;
      while (Date.now() < deadline) {
        const [execution] =
          await handle.sql`select outcome_detail from attempt where job_id = ${id} and ended_at is not null order by epoch desc limit 1`;
        if (execution) {
          const result = attemptOutcome.parse(execution.outcome_detail);
          if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
          return result.summary;
        }
        const state = (await service.jobs.get(id)).state;
        if (!['queued', 'running'].includes(state))
          throw new Error(`Job entered ${state} without a completed attempt`);
        await Bun.sleep(50);
      }
      throw new Error(`Job ${id} did not finish`);
    }
    try {
      // Seed just the durable account/connection, then boot exactly the W15 product path.
      const ownerId = newId('own');
      const personalId = newId('sp');
      const hash = await Bun.password.hash('capability-proof-password', { algorithm: 'argon2id' });
      await handle.sql`insert into owner (id, email, password_hash) values (${ownerId}, 'capability@example.test', ${hash})`;
      await handle.sql`insert into principal (id, email, password_hash) values (${ownerId}, 'capability@example.test', ${hash})`;
      await handle.sql`insert into space (id, name, git_path, owner_principal_id) values (${personalId}, 'Personal', ${join(spaces, personalId)}, ${ownerId})`;
      await handle.sql`insert into connection (id, space_id, provider, label, scopes, status) values (${connectionId}, ${personalId}, 'mcp', 'Capability fixture', '["mcp_fixture.read"]'::jsonb, 'active')`;
      service = await bootstrap({
        workers: false,
        env: loadEnv({
          NODE_ENV: 'test',
          DATABASE_URL: handle.url,
          PORT: '3160',
          MELETE_RUNTIME_ADAPTER: 'hermes',
          MELETE_RUNTIME_SUPERVISOR: 'process',
          MELETE_CAPABILITY_KEY: KEY,
          MELETE_APPROVAL_KEY: 'w14-proof-approval-key-at-least-32',
          MELETE_SPACES_DIR: spaces,
          MELETE_WORK_DIR: join(root, 'work'),
          MELETE_BROKER_BIND: '127.0.0.1:3162',
          MELETE_BROKER_URL: 'http://127.0.0.1:3162',
          MELETE_CONNECTIONS_FILE: configPath,
          MELETE_ENABLE_FAKE_PROVIDER: 'true',
          MELETE_DEFAULT_PROVIDER: 'fake',
          MELETE_DEFAULT_MODEL: 'scripted-learning-v1',
        }),
        fakeProvider: async (body, id, protocol) => {
          if (!installationProbe && JSON.stringify(body).includes('W14 MCP discovery')) {
            const [active] =
              await handle.sql`select j.state from attempt a join job j on j.id = a.job_id where a.id = ${id}`;
            const response = await call('/connections', {
              provider: 'mcp',
              space_id: personalId,
              server: serverConfig,
            });
            installationProbe = {
              status: response.status,
              body: await response.text(),
              jobState: String(active?.state),
            };
          }
          return provider.fake(body, id, protocol);
        },
        onBundle: (bundle) => bundles.push(bundle),
        onTiming: (timing) =>
          process.stdout.write(`W14 Hermes ${timing.attemptId}: ${timing.wallMs}ms\n`),
      });
      const { jobs, queue, memory, broker, registry } = service;
      if (!jobs || !queue || !memory || !broker || !registry)
        throw new Error('Missing service dependency');
      const connector = registry.get(connectionId);
      if (!connector) throw new Error('Missing MCP connector');
      api = Bun.serve({
        hostname: '127.0.0.1',
        port: 3160,
        fetch: service.app.fetch,
        idleTimeout: 0,
      });
      const login = await call('/login', {
        email: 'capability@example.test',
        password: 'capability-proof-password',
      });
      expect(login.status).toBe(200);
      cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      const member = await json<{ principal: { id: string } }>(
        await call('/principals', {
          email: 'teammate@example.test',
          password: 'teammate-proof-password',
        }),
        201,
      );
      const loginMember = await call('/login', {
        email: 'teammate@example.test',
        password: 'teammate-proof-password',
      });
      expect(loginMember.status).toBe(200);
      const memberCookie = loginMember.headers.get('set-cookie')?.split(';')[0] ?? '';
      const shared = await json<{ space: { id: string } }>(
        await call('/spaces/shared', { name: 'Shared proof' }),
        201,
      );
      const sharedId = shared.space.id;
      await json(
        await call(`/spaces/${sharedId}/memberships`, { principal_id: member.principal.id }),
        201,
      );

      await stage('dynamic discovery and broker receipt', async () => {
        const id = await create(
          personalId,
          'MCP',
          'W14 MCP discovery: search, load, read capability fixture.',
        );
        let outcomeError: unknown;
        try {
          await run(id);
        } catch (error) {
          outcomeError = error;
        }
        const [action] =
          await handle.sql`select kind, status, receipt from action where job_id = ${id}`;
        evidence.mcp = {
          calls,
          action,
          outcomeError: outcomeError instanceof Error ? outcomeError.message : null,
        };
        evidence.mcpEvents =
          await handle.sql`select seq, type, payload from event where job_id = ${id} order by seq`;
        expect(action).toMatchObject({ kind: 'mcp_fixture.read', status: 'succeeded' });
        expect(calls).toBe(1);
        const bundle = bundles.find((value) => value.attempt.job_id === id);
        expect(bundle?.tools.map((tool) => tool.name)).not.toContain('mcp_fixture.read');
        const delivered = JSON.stringify(provider.requests.get(bundle?.attempt.id ?? ''));
        expect(delivered).toContain('fixture-value-verified');
        const hooks =
          await handle.sql`select type, payload from event where job_id = ${id} and type in ('hook_event','hook_error') order by seq`;
        const names = hooks.map((row) => row.payload.hook?.name ?? row.payload.name);
        expect(names).toContain('on_session_start');
        expect(names).toContain('pre_tool_call');
        expect(names).toContain('post_tool_call');
        expect(names).toContain('on_session_end');
        return { jobId: id, calls, hooks: names };
      });
      await stage('mid-session installation and disconnect boundary', async () => {
        expect(installationProbe?.jobState).toBe('running');
        expect(installationProbe?.status).toBe(404);
        gaps.push(
          'MCP installation after session start: no operator installation route; stdio service launcher is disabled',
        );
        connected = false;
        expect((await connector.health()).status).toBe('failing');
        connected = true;
        expect((await connector.health()).status).toBe('ok');
        gaps.push(
          'MCP disconnect repair: transport loss becomes unknown; no MCP reconnect or credential-refresh callback',
        );
        return installationProbe;
      });

      await stage('correction, evaluation, private reuse and rollback', async () => {
        const original = await create(
          sharedId,
          training.template,
          taskObjective(training.task),
          cookie,
          true,
        );
        expect(gradeRecords(training, await run(original))).toBe(false);
        const corrected = await json<{ episode: { id: string; correctiveJobId: string } }>(
          await call(`/jobs/${original}/interventions`, {
            idempotency_key: 'w14-correction',
            kind: 'correction',
            signal: 'typed_ordering',
            text: `${PRIVATE}: compare dates chronologically using the declared date format; preserve columns and rows.`,
          }),
          201,
        );
        expect(gradeRecords(training, await run(corrected.episode.correctiveJobId))).toBe(true);
        const proposal = await json<{ candidate: { id: string; body: string } }>(
          await call(`/episodes/${corrected.episode.id}/propose`, { space_id: sharedId }),
          201,
        );
        expect(proposal.candidate.body).not.toContain(PRIVATE);
        const proposedBytes = [...provider.requests]
          .filter(([id]) => id.startsWith('proposal:'))
          .map(([, body]) => body);
        expect(proposedBytes.length).toBe(1);
        expect(JSON.stringify(proposedBytes)).not.toContain(PRIVATE);
        const candidateId = proposal.candidate.id;
        const evaluated = await json<{ evaluations: { passed: boolean }[] }>(
          await call(`/procedures/${candidateId}/evaluate`, { space_id: sharedId }),
        );
        evidence.evaluations =
          await handle.sql`select phase, passed, evidence, budget from procedure_evaluation where candidate_id = ${candidateId}`;
        evidence.evaluationOutputs =
          await handle.sql`select a.outcome, a.outcome_detail from attempt a join learning_trial t on t.job_id = a.job_id where t.candidate_id = ${candidateId} order by a.started_at`;
        expect(evaluated.evaluations).toHaveLength(2);
        expect(evaluated.evaluations.every((row) => row.passed)).toBe(true);
        await json(await call(`/procedures/${candidateId}/canary`, { space_id: sharedId }));
        const next = await create(
          sharedId,
          later.template,
          taskObjective(later.task),
          cookie,
          true,
        );
        expect(gradeRecords(later, await run(next))).toBe(true);
        const bundle = bundles.find((value) => value.attempt.job_id === next);
        expect(bundle?.skills.map((skill) => skill.name)).toContain(`procedure:${candidateId}`);
        expect(JSON.stringify(provider.requests.get(bundle?.attempt.id ?? ''))).not.toContain(
          PRIVATE,
        );
        await json(await call(`/procedures/${candidateId}/activate`, { space_id: sharedId }));
        const memberTask = await create(
          sharedId,
          'w14-member-dates',
          taskObjective(later.task),
          memberCookie,
          true,
        );
        await run(memberTask);
        expect(
          bundles
            .find((value) => value.attempt.job_id === memberTask)
            ?.skills.map((skill) => skill.name),
        ).not.toContain(`procedure:${candidateId}`);
        // A qualified shared procedure is not representable by the current learning contract.
        expect(
          procedureScope.safeParse({ ...EVALUATED_SCOPE, audience: `space:${sharedId}` }).success,
        ).toBe(false);
        gaps.push(
          'Evaluated teammate reuse: procedure scope is owner/private; no shared promotion or member delivery contract',
        );
        expect(
          (
            await call(
              `/procedures/${candidateId}?space_id=${sharedId}`,
              undefined,
              'GET',
              memberCookie,
            )
          ).status,
        ).toBe(403);
        await json(
          await call(`/procedures/${candidateId}/rollback`, {
            space_id: sharedId,
            reason: 'End capability proof',
          }),
        );
        const after = await create(
          sharedId,
          'w14-after-rollback',
          taskObjective(later.task),
          cookie,
          true,
        );
        await run(after);
        expect(
          bundles
            .find((value) => value.attempt.job_id === after)
            ?.skills.map((skill) => skill.name),
        ).not.toContain(`procedure:${candidateId}`);
        return {
          original,
          corrective: corrected.episode.correctiveJobId,
          candidateId,
          reuse: next,
          rollback: after,
        };
      });

      await stage('teammate audience isolation and revocation', async () => {
        const skills = join(spaces, sharedId, 'skills');
        await mkdir(skills, { recursive: true });
        for (const name of ['alpha', 'beta', 'gamma', 'zeta'])
          await writeFile(
            join(skills, `${name}.md`),
            `---\nname: ${name}\ndescription: Shared records\ntriggers: [records]\ntools: []\naudience: space:${sharedId}\n---\nUse shared ${name} procedure.`,
          );
        await writeFile(
          join(skills, 'private.md'),
          `---\nname: aaa-private\ndescription: Private records\ntriggers: [records]\ntools: []\naudience: private\n---\n${PRIVATE}`,
        );
        const ownerJob = await create(sharedId, 'Owner', 'records');
        const ownerScope = await memory.scopeForJob(ownerJob);
        await record(
          { ...handle, boss: queue.boss },
          ownerScope,
          {
            identity: 'w14-private-memory',
            text: `records ${PRIVATE}`,
            eventAt: '2026-09-01T00:00:00Z',
          },
          [{ key: 'records.private', content: PRIVATE, quote: PRIVATE, kind: 'user_statement' }],
        );
        const next = await create(sharedId, 'Member', 'records', memberCookie);
        expect(await memory.scopeForJob(next)).toMatchObject({
          principalId: member.principal.id,
          role: 'reader',
          audience: 'space',
        });
        await run(next);
        const bundle = bundles.find((value) => value.attempt.job_id === next);
        expect(bundle?.principal_id).toBe(member.principal.id);
        expect(bundle?.skills.map((skill) => skill.name)).toEqual(['alpha', 'beta', 'gamma']);
        expect(JSON.stringify(bundle)).not.toContain(PRIVATE);
        expect(JSON.stringify(provider.requests.get(bundle?.attempt.id ?? ''))).not.toContain(
          PRIVATE,
        );
        const queued = await create(sharedId, 'Revoke queued', 'records', memberCookie);
        await json(
          await call(`/spaces/${sharedId}/memberships/${member.principal.id}`, undefined, 'DELETE'),
        );
        expect((await jobs.get(queued)).state).toBe('cancelled');
        expect((await call(`/jobs/${next}`, undefined, 'GET', memberCookie)).status).toBe(403);
        expect(
          (
            await call(
              '/jobs',
              { space_id: sharedId, title: 'Denied', objective: 'records' },
              'POST',
              memberCookie,
            )
          ).status,
        ).toBe(403);
        expect(
          (
            (await call('/spaces', undefined, 'GET', memberCookie).then((response) =>
              response.json(),
            )) as { spaces: { id: string }[] }
          ).spaces.map((row) => row.id),
        ).not.toContain(personalId);
        const [ownSpace] =
          await handle.sql`select id from space where owner_principal_id = ${member.principal.id} and kind = 'personal'`;
        if (!ownSpace) throw new Error('Missing teammate personal space');
        const clean = await jobs.transaction((tx) =>
          selectedContext(tx, ownSpace.id, member.principal.id, 'records', ''),
        );
        expect(JSON.stringify(clean)).not.toContain('Use shared');
        if (!bundle) throw new Error('No member bundle');
        let denied = false;
        try {
          await broker.authorize(verifyCapability(bundle.attempt.token, KEY));
        } catch {
          denied = true;
        }
        expect(denied).toBe(true);
        return {
          jobId: next,
          queued,
          selected: bundle.skills.map((skill) => skill.name),
          revoked: true,
        };
      });
      evidence.failures = failures;
      expect(failures).toEqual([]);
      if (process.env.MELETE_CAPABILITY_PROOF === '1') expect(gaps).toEqual([]);
    } finally {
      evidence.failures = failures;
      evidence.mcpCalls = calls;
      await writeFile(
        join(root, 'capability-evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      await writeFile(
        join(root, 'provider-requests.json'),
        `${JSON.stringify([...provider.requests], null, 2)}\n`,
      );
      process.stdout.write(`W14 capability evidence: ${join(root, 'capability-evidence.json')}\n`);
      await api?.stop(true);
      await service?.close();
      await mcp.stop(true);
      await handle.close();
      // Keep the small evidence files; remove only this fixture's verified work and space trees.
      for (const name of ['work', 'spaces']) {
        const target = resolve(root, name);
        expect(dirname(target)).toBe(resolve(root));
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      expect(
        JSON.parse(await readFile(join(root, 'capability-evidence.json'), 'utf8')).engine,
      ).toBe('hermes@v2026.9.7');
    }
  },
  900000,
);
