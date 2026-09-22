import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AttemptBundle } from '@melete/contracts';
import { loadEnv } from '../../src/env.ts';
import { createScriptedProvider } from '../../src/gateway/fake.ts';
import { newId } from '../../src/ids.ts';
import { bootstrap } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { FileRestrictionJournal } from '../../src/memory/restore.ts';
import type { AttemptTiming } from '../../src/runtime/hermes.ts';
import { testDatabase } from '../helpers/database.ts';
import { createScope } from './postgres.ts';
import { head, record } from './properties-fixtures.ts';

const configured = loadEnv({});
const localEngine = existsSync(configured.MELETE_HERMES_PYTHON);
if (!localEngine)
  process.stdout.write(
    'wired assistant skipped: .hermes-venv is absent; install the pinned local Hermes first\n',
  );
const handle = localEngine ? await testDatabase() : null;
afterAll(async () => {
  await handle?.close();
}, 30_000);

(handle ? describe : describe.skip)('wired assistant through HTTP and pinned Hermes', () => {
  test('skills, handled recall, delta and correction repair reach the model from bootstrap', async () => {
    if (!handle) return;
    const root = await mkdtemp(join(tmpdir(), 'melete-wired-assistant-'));
    const spaces = join(root, 'spaces');
    const seedQueue = await startQueue(handle.url);
    const db = { ...handle, boss: seedQueue.boss };
    const scope = await createScope(db);
    const skills = join(spaces, scope.spaceId, 'skills');
    await mkdir(skills, { recursive: true });
    await promisify(execFile)('git', ['-C', join(spaces, scope.spaceId), 'init', '--quiet'], {
      windowsHide: true,
    });
    await handle.sql`update space set git_path = ${join(spaces, scope.spaceId)} where id = ${scope.spaceId}`;
    for (const name of ['alpha', 'beta', 'gamma', 'zeta'])
      await writeFile(
        join(skills, `${name}.md`),
        `---\nname: ${name}\ndescription: Travel procedure\ntriggers: [travel]\ntools: []\n---\nUse the ${name} travel procedure.`,
      );
    const seeded = await record(
      db,
      scope,
      {
        identity: 'travel-preferences',
        text: 'travel seat aisle and travel meal vegan',
        eventAt: '2026-09-01T00:00:00Z',
      },
      [
        { key: 'pref.travel.seat', content: 'aisle', quote: 'aisle', kind: 'user_statement' },
        { key: 'pref.travel.meal', content: 'vegan', quote: 'vegan', kind: 'user_statement' },
      ],
    );
    expect(seeded.status).toBe('committed');
    const seat = await head(db, scope, 'pref.travel.seat');
    if (!seat) throw new Error('Missing seeded seat preference');
    const password = 'wired-local-proof-password';
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
    await handle.sql`update owner set email = 'wired@example.test', password_hash = ${passwordHash}`;
    // Login reads the principal created by the fixture, not the singleton setup record.
    await handle.sql`update principal set email = 'wired@example.test', password_hash = ${passwordHash} where id = ${scope.ownerId}`;
    await handle.sql`insert into connection (id, space_id, provider, label, scopes, status)
      values (${newId('conn')}, ${scope.spaceId}, 'test', 'Scripted send', '["test.send"]'::jsonb, 'active')`;
    await new FileRestrictionJournal(join(spaces, '.memory', 'restrictions.jsonl')).initializeNew();
    await seedQueue.stop();

    const bundles: AttemptBundle[] = [];
    const timings: AttemptTiming[] = [];
    const requests = new Map<string, string[]>();
    const scripted = createScriptedProvider();
    const service = await bootstrap({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: handle.url,
        PORT: '3170',
        MELETE_RUNTIME_ADAPTER: 'hermes',
        MELETE_RUNTIME_SUPERVISOR: 'process',
        MELETE_CAPABILITY_KEY: 'wired-capability-key-32-characters-long',
        MELETE_APPROVAL_KEY: 'wired-approval-key-32-characters-long',
        MELETE_SPACES_DIR: spaces,
        MELETE_WORK_DIR: join(root, 'work'),
        MELETE_BROKER_BIND: '127.0.0.1:3172',
        MELETE_BROKER_URL: 'http://127.0.0.1:3172',
        MELETE_ENABLE_TEST_CONNECTOR: 'true',
        MELETE_ENABLE_FAKE_PROVIDER: 'true',
        MELETE_DEFAULT_PROVIDER: 'fake',
        MELETE_DEFAULT_MODEL: 'scripted',
      }),
      onBundle: (bundle) => bundles.push(bundle),
      onTiming: (timing) => timings.push(timing),
      fakeProvider: async (body, attemptId, protocol) => {
        requests.set(attemptId, [...(requests.get(attemptId) ?? []), JSON.stringify(body)]);
        return scripted(body, attemptId, protocol);
      },
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 3170,
      fetch: service.app.fetch,
      idleTimeout: 0,
    });
    let cookie = '';
    const call = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:3170${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          'x-melete-space': scope.spaceId,
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    let jobId: string | undefined;
    try {
      expect(await (await call('/health')).json()).toMatchObject({
        runtime_adapter: 'hermes',
        database: 'ok',
      });
      // A supplied space header cannot authenticate a memory request.
      expect((await call('/memory/claims')).status).toBe(401);
      const login = await call('/login', { email: 'wired@example.test', password });
      expect(login.status).toBe(200);
      cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).toStartWith('melete_session=');
      expect(
        (await call('/memory/claims', undefined, { cookie: `melete_session=${'x'.repeat(43)}` }))
          .status,
      ).toBe(401);
      expect(
        (await call('/memory/claims', undefined, { 'x-melete-space': newId('sp') })).status,
      ).toBe(403);
      const created = await call(
        '/jobs',
        {
          space_id: scope.spaceId,
          title: 'Travel plan',
          objective: 'travel',
        },
        { 'Idempotency-Key': 'wired-assistant-job' },
      );
      expect(created.status).toBe(201);
      const body = (await created.json()) as { job: { id: string } };
      jobId = body.job.id;
      const waitForAttempt = async (count: number) => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const rows =
            await handle.sql`select id, outcome, outcome_detail from attempt where job_id = ${body.job.id} and ended_at is not null order by epoch`;
          if (rows.length >= count) {
            const current = rows[count - 1];
            if (current?.outcome !== 'waiting_for_approval')
              throw new Error(`Hermes attempt ended unexpectedly: ${JSON.stringify(current)}`);
            return;
          }
          await Bun.sleep(100);
        }
        throw new Error(`Hermes attempt ${count} did not finish within 90 seconds`);
      };
      await waitForAttempt(1);
      const first = bundles[0];
      if (!first) throw new Error('No first bundle');
      expect(first.budget.max_output_tokens).toBe(8000);
      expect(first.budget.max_input_tokens).toBe(120000);
      expect(first.skills.map((skill) => skill.name)).toEqual(['alpha', 'beta', 'gamma']);
      expect(first.knowledge).toHaveLength(2);
      expect(first.knowledge.map((item) => item.handle)).toContain(`${seat.id}@1`);
      expect(first.tools.map((tool) => tool.name)).toEqual([
        'search_tools',
        'load_tool',
        'react',
        'test.send',
      ]);
      expect(first.inputs.since_last).toBeUndefined();
      expect(first.since_last.attempt_id).toBeNull();
      expect(first.since_last.evidence.map((item) => item.handle)).toEqual([
        `source:${seeded.sourceId}@1`,
      ]);
      expect(
        (
          await call('/memory/outputs', {
            job_id: jobId,
            attempt_id: first.attempt.id,
            kind: 'plan_step',
            output_id: 'travel-plan',
            output_version: '1',
            location: 'seat',
            uses: [`${seat.id}@1`],
          })
        ).status,
      ).toBe(201);
      const corrected = await call('/memory/corrections', {
        claim_id: seat.id,
        expected_revision: 1,
        text: 'travel seat window',
        content: 'window',
        valid_from: '2026-09-05T00:00:00Z',
        valid_until: null,
        idempotency_key: 'wired-assistant-window',
      });
      expect(corrected.status).toBe(200);
      await waitForAttempt(2);
      const second = bundles[1];
      if (!second) throw new Error('No replacement bundle');
      expect(second.attempt.token).not.toBe(first.attempt.token);
      expect(second.since_last.attempt_id).toBe(first.attempt.id);
      expect(second.since_last.pending_approvals.length).toBeGreaterThan(0);
      expect(second.inputs.repair_briefs).toHaveLength(1);
      expect(second.inputs.repair_briefs[0]).toMatchObject({
        changed_handle: `${seat.id}@1`,
        replacement_handle: `${seat.id}@2`,
      });
      expect(second.knowledge.map((item) => item.handle)).toContain(`${seat.id}@2`);
      for (const bundle of [first, second]) {
        const delivered = requests.get(bundle.attempt.id)?.join('\n') ?? '';
        for (const skill of bundle.skills) expect(delivered).toContain(skill.body);
        for (const knowledge of bundle.knowledge) {
          expect(knowledge.handle).toBeDefined();
          expect(delivered).toContain(knowledge.handle ?? 'missing handle');
        }
        expect(delivered).toContain('Since the last attempt');
        for (const evidence of bundle.since_last.evidence)
          expect(delivered).toContain(evidence.handle);
        for (const approval of bundle.since_last.pending_approvals)
          expect(delivered).toContain(
            `approval ${approval.approval_id} is waiting on action ${approval.action_id}`,
          );
        const [context] =
          await handle.sql`select style_violations, items from memory_contexts where attempt_id = ${bundle.attempt.id}`;
        expect(context?.style_violations).toEqual([]);
        expect(
          ((context?.items ?? []) as { handle: string }[]).map((item) => item.handle),
        ).toContain(bundle.knowledge[0]?.handle ?? 'missing handle');
      }
      const replacementRequest = requests.get(second.attempt.id)?.join('\n') ?? '';
      expect(replacementRequest).toContain('Repair required');
      expect(replacementRequest).toContain(`${seat.id}@1`);
      expect(replacementRequest).toContain(`${seat.id}@2`);
      expect(timings).toHaveLength(2);
      for (const timing of timings) {
        expect(timing.coldStartMs).toBeGreaterThan(0);
        expect(timing.wallMs).toBeGreaterThanOrEqual(timing.coldStartMs);
        process.stdout.write(
          `wired Hermes ${timing.attemptId}: cold=${timing.coldStartMs}ms wall=${timing.wallMs}ms\n`,
        );
      }
    } finally {
      if (jobId) await call(`/jobs/${jobId}/cancel`, {}).catch(() => {});
      await server.stop(true);
      await service.close();
      if (
        resolve(root).startsWith(
          `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}melete-wired-assistant-`,
        )
      )
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 210_000);
});
