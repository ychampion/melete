/**
 * An app kept current by a real routine: the person's routine is made through
 * the automations path, the agent finds it with `apps.routines`, binds the
 * app's data to it before it has ever run, and each run's checked write is
 * what the app shows next, with no new version of the app.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentResponse,
  automationResponse,
  type CapabilityClaims,
  type JsonObject,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { mountApps } from '../../src/apps/routes.ts';
import { createArtifactRecorder } from '../../src/artifact/record.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createAppsConnector } from '../../src/connectors/apps.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { session } from '../../src/db/auth-schema.ts';
import { owner, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { createApp } from '../../src/index.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

void QUEUES;
const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'app-routine-fixture-signing-key-32b',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : undefined;
const service = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      triggers,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const databaseTest = handle ? test : test.skip;

afterAll(async () => {
  await triggers?.stop();
  await runner?.stop();
  await queue?.stop();
  await handle?.close();
}, 30_000);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

databaseTest(
  'a binding serves the newest version a routine wrote, without a republish',
  async () => {
    const { sql, db } = required(handle);
    const scopes = ['apps.publish', 'apps.routines', 'files.write'];
    const seed = await seedJob(sql, { scopes, provider: 'apps' });
    const spaceId = seed.claims.space_id;
    // The person, signed in, owning the space the chat is in.
    const person = recordId('own');
    await db.insert(owner).values({ id: person, email: `routine-${person}@example.test` });
    await sql`insert into principal (id, email) select id, email from owner where id = ${person}`;
    await sql`update space set owner_principal_id = ${person} where id = ${spaceId}`;
    await sql`update job set principal_id = ${person} where id = ${seed.claims.job_id}`;
    const token = randomBytes(32).toString('base64url');
    await db.insert(session).values({
      tokenHash: createHash('sha256').update(token).digest('hex'),
      ownerId: person,
      spaceId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const request = (route: string, method = 'GET', body?: unknown) =>
      required(service).request(route, {
        method,
        headers: {
          Cookie: `melete_session=${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    // A broker with the Apps and Files connections of this space.
    const roots = await mkdtemp(path.join(tmpdir(), 'melete-app-routine-'));
    const workRoot = path.join(roots, 'work');
    const spacesRoot = path.join(roots, 'spaces');
    const filesConnection = recordId('conn');
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${filesConnection}, ${spaceId}, 'files', 'Files', ${JSON.stringify(['files.write'])}::jsonb)`;
    const blobs = new LocalBlobStore(path.join(roots, 'blobs'));
    const broker = new BrokerService({
      sql,
      connectors: new ConnectorRegistry()
        .register(seed.connectionId, createAppsConnector({ sql, workRoot, blobs }))
        .register(filesConnection, createFilesConnector({ workRoot, spacesRoot })),
      recordArtifact: createArtifactRecorder(undefined, { workRoot, spacesRoot }),
    });
    const run = async (
      claims: CapabilityClaims,
      kind: string,
      connection: string,
      payload: JsonObject,
    ) => {
      const proposal = await broker.propose(claims, { kind, connection_id: connection, payload });
      if (proposal.status === 'needs_approval')
        await broker.decide(proposal.action_id, {
          decision: 'approved',
          payload_hash: proposal.payload_hash,
        });
      if (proposal.status !== 'succeeded' && proposal.status !== 'failed') {
        await broker.admit(claims, proposal.action_id, proposal.payload_hash);
        await broker.dispatch(proposal.action_id);
      }
      const [row] = await sql<{ status: string; receipt: { detail?: JsonObject } | null }[]>`
        select status, receipt from action where id = ${proposal.action_id}`;
      return { status: row?.status, detail: (row?.receipt?.detail ?? {}) as JsonObject };
    };
    const data = async (appId: string) => {
      const app = new Hono();
      app.onError((error, c) =>
        error instanceof ServiceError
          ? c.json({ error: { code: error.code, message: error.message } }, error.status)
          : c.json({ error: { code: 'internal_error', message: error.message } }, 500),
      );
      app.use('*', async (c, next) => {
        c.set('owner' as never, { id: person } as never);
        await next();
      });
      mountApps(app, { sql, blobs, roots: { workRoot, spacesRoot } });
      return (await (await app.request(`/apps/${appId}/data/deals`)).json()) as JsonObject;
    };

    // The person sets up a morning routine through the automations path.
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
    ).agent;
    const routine = automationResponse.parse(
      await (
        await request('/automations', 'POST', {
          title: 'Morning deals',
          instruction: 'Rewrite data/deals.json with the open deals.',
          weekdays: [1, 2, 3, 4, 5],
          at: '07:00',
          agent_id: persona.id,
        })
      ).json(),
    ).automation;

    // The agent finds it by name and binds the app to it before it has ever run.
    const listed = await run(seed.claims, 'apps.routines', seed.connectionId, {});
    expect(listed.status).toBe('succeeded');
    const found = (listed.detail.routines as { routine_id: string; title: string }[]).find(
      (entry) => entry.title === 'Morning deals',
    );
    expect(found?.routine_id).toBe(routine.id);
    await Bun.write(
      path.join(workRoot, seed.claims.job_id, 'app', 'index.html'),
      '<!doctype html><title>Deals</title>',
    );
    const asked = await broker.propose(seed.claims, {
      kind: 'apps.publish',
      connection_id: seed.connectionId,
      payload: {
        dir: 'app',
        name: 'Deals',
        data: { deals: { artifact: 'data/deals.json', source: routine.id } },
      },
    });
    expect(asked.canonical_payload.data_shown).toEqual([
      'deals: data/deals.json from the routine "Morning deals", newest version each time',
    ]);
    const published = await run(seed.claims, 'apps.publish', seed.connectionId, {
      dir: 'app',
      name: 'Deals',
      data: { deals: { artifact: 'data/deals.json', source: routine.id } },
    });
    expect(published.status).toBe('succeeded');
    const appId = String(published.detail.app_id);
    const [version] = await sql`select current_version_id from app where id = ${appId}`;
    expect(await data(appId)).toMatchObject({ state: 'none', value: null });

    /** One run of the routine: it fires, and its attempt saves the file as a checked file. */
    const runRoutine = async (content: string) => {
      expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
      const [registration] = await db.select().from(trigger).where(eq(trigger.id, routine.id));
      const row = await required(jobs).get(required(registration).jobId);
      const claimed = required(
        await required(runner).claim({
          job_id: row.id,
          expected_epoch: row.leaseEpoch,
          expected_version: row.stateVersion,
          reason: 'event',
        }),
      );
      const wrote = await run(claimed.claims, 'files.write', filesConnection, {
        path: 'data/deals.json',
        content,
        expect: { kind: 'json' },
      });
      expect(wrote.status).toBe('succeeded');
      // The run ends as the runner ends it: the write's receipt wakes the routine once more,
      // and that attempt finishes with nothing left to do.
      let claims = claimed.claims;
      for (let tries = 0; tries < 5; tries += 1) {
        await required(runner)
          .commitOutcome(claims, { kind: 'completed', summary: 'Rewrote the deals.', evidence: [] })
          .catch((error: { code?: string }) => {
            if (error.code !== 'stale_epoch') throw error;
          });
        const now = await required(jobs).get(row.id);
        if (now.state === 'waiting_for_event_or_time') break;
        const again = await required(runner).claim({
          job_id: row.id,
          expected_epoch: now.leaseEpoch,
          expected_version: now.stateVersion,
          reason: 'event',
        });
        if (again) claims = again.claims;
      }
      expect((await required(jobs).get(row.id)).state).toBe('waiting_for_event_or_time');
    };

    await runRoutine('[{"company":"Acme"}]');
    expect(await data(appId)).toMatchObject({ state: 'ready', value: [{ company: 'Acme' }] });
    await runRoutine('[{"company":"Acme"},{"company":"Globex"}]');
    expect((await data(appId)).value).toEqual([{ company: 'Acme' }, { company: 'Globex' }]);
    const [after] = await sql`select current_version_id from app where id = ${appId}`;
    expect(after?.current_version_id).toBe(version?.current_version_id);

    // A routine id that is not one of the person's in this space is refused.
    const stranger = await broker
      .propose(seed.claims, {
        kind: 'apps.publish',
        connection_id: seed.connectionId,
        payload: {
          dir: 'app',
          name: 'X',
          data: { d: { artifact: 'data/x.json', source: 'trg_00000000000000000000000000' } },
        },
      })
      .catch((error: { code?: string }) => error);
    // The same words whether or not such a routine exists anywhere.
    expect(stranger).toMatchObject({
      code: 'payload_invalid',
      message: 'Data "d" names a conversation or routine that is not one of yours in this space.',
    });
  },
  60_000,
);
