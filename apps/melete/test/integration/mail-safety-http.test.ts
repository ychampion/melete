import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, RuntimeAdapter } from '@melete/contracts';
import corpus from '../../../../evals/mail-safety/corpus.json' with { type: 'json' };
import { type Case, emailBytes } from '../../../../evals/mail-safety/generate.ts';
import { gradeCase } from '../../../../evals/mail-safety/grade.ts';
import { AppHttp, collect, preflight, submitNotice } from '../../../../evals/mail-safety/http.ts';
import { TINY_PNG } from '../../src/attachments/fixtures.ts';
import { gatewayAttachments } from '../../src/attachments/model.ts';
import { AttachmentService } from '../../src/attachments/store.ts';
import { verifyCapability } from '../../src/broker/capability.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { EmailConnector } from '../../src/connectors/email.ts';
import { type MailTransport, parseMailMessage } from '../../src/connectors/mail-transport.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import { withAttachedFiles } from '../../src/gateway/attachments.ts';
import type { GatewayPrincipal } from '../../src/gateway/types.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import { roomHandle } from '../../src/rooms/transcript.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const queue = fixture ? await startQueue(fixture.url) : null;
const directory = await mkdtemp(join(tmpdir(), 'mail-safety-http-'));
const registry = new ConnectorRegistry();
const jobs = fixture && queue ? new JobService(fixture.db, queue.boss) : null;
const broker = fixture ? new BrokerService({ sql: fixture.sql, connectors: registry }) : null;
const store = new LocalBlobStore(join(directory, 'blobs'));
const attachments = fixture ? new AttachmentService(fixture.sql, store) : null;
const key = 'mail-safety-fixture-signing-key-32-bytes';
let imagePayload = '';
let mailReads = 0;
const runtime = new StubRuntimeAdapter({
  onTool: async (callId, args, bundle) => {
    if (!fixture || !broker) throw new Error('No fixture');
    if (callId === 'photo-read') {
      const input = bundle.inputs.new_user_messages.map((m) => m.content).join('\n');
      const payload = await withAttachedFiles({
        body: { messages: [{ role: 'user', content: input }] },
        protocol: 'chat/completions',
        provider: 'fake',
        model: 'scripted-vision',
        principal: { privacy: { kind: 'job' }, jobId: bundle.attempt.job_id } as GatewayPrincipal,
        route: { kind: 'cloud', private: false },
        source: gatewayAttachments(fixture.sql, store, async () => true),
        maxRequestBytes: 8_000_000,
      });
      imagePayload = JSON.stringify(payload);
      return { viewed: true };
    }
    const result = await broker.propose(verifyCapability(bundle.attempt.token, key), {
      connection_id: String(args.connection),
      kind: String(args.kind),
      payload: args.payload as JsonObject,
    });
    expect(result.requires_approval).toBe(false);
    const [action] =
      await fixture.sql`select status, receipt from action where id = ${result.action_id}`;
    expect(action?.status).toBe('succeeded');
    return action?.receipt?.detail ?? {};
  },
});
const scripts = new Map<string, StubStep[]>();
const scripted: RuntimeAdapter = {
  capabilities: () => runtime.capabilities(),
  start: (bundle, sink, signal) =>
    runtime.start(
      {
        ...bundle,
        job: {
          ...bundle.job,
          constraints: {
            ...bundle.job.constraints,
            script: scripts.get(bundle.attempt.job_id) ?? [],
          } as unknown as JsonObject,
        },
      },
      sink,
      signal,
    ),
};
const runner = jobs
  ? new AttemptRunner(jobs, scripted, {
      key,
      liveConnectionScopes: true,
      provider: 'fake',
      model: 'scripted-vision',
    })
  : null;
const app =
  fixture && jobs && runner && broker && attachments
    ? createApp({
        env: loadEnv({
          NODE_ENV: 'test',
          MELETE_PREVIEW_MULTIPLAYER: 'true',
          MELETE_ENABLE_FAKE_PROVIDER: 'true',
          MELETE_DEFAULT_PROVIDER: 'fake',
          MELETE_DEFAULT_MODEL: 'scripted-vision',
          MELETE_SPACES_DIR: directory,
        }),
        db: fixture.db,
        sql: fixture.sql,
        jobs,
        runner,
        broker,
        registry,
        attachments,
        memory: {
          sql: fixture.sql,
          journal: { read: async () => [], append: async () => {} },
          storageScope: async (spaceId) => {
            await provisionMemorySpace(fixture.sql, owner.id, spaceId);
            return {
              ownerId: owner.id,
              spaceId,
              publisher: 'service',
              audience: 'space',
              role: 'owner',
            };
          },
        },
        checkDatabase: async () => 'ok',
      })
    : null;
const withDb = app ? describe : describe.skip;
type Person = { id: string; cookie: string };
let owner: Person;
let helper: Person;
let outsider: Person;
const password = 'mail-safety-fixture-password';
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .find((s) => s?.startsWith('melete_session=')) ?? '';
function http(person: Person) {
  if (!app) throw new Error('No app');
  return new AppHttp('http://app.example.test', person.cookie, async (request) =>
    app.request(request),
  );
}
const post = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const clients = () => ({ owner: http(owner), helper: http(helper), outsider: http(outsider) });
const accounts = () => ({ owner, helper, outsider });
async function room() {
  const made = await http(owner).json<{ room: { id: string } }>(
    '/rooms',
    post({ name: 'Notice review' }),
  );
  const roomId = made.room.id;
  await http(owner).json(`/rooms/${roomId}/members`, post({ principal_id: helper.id }));
  await http(owner).json(`/spaces/${roomId}/summaries-only`, post({ on: true }, 'PUT'));
  const detail = await http(owner).json<{
    members: { principal_id: string; display_name: string }[];
  }>(`/rooms/${roomId}`);
  return {
    roomId,
    helperLabel: detail.members.find((m) => m.principal_id === helper.id)!.display_name,
    helperConsent: true,
  };
}
async function play(jobId: string, steps: StubStep[]) {
  if (!fixture || !runner) throw new Error('No fixture');
  scripts.set(jobId, steps);
  const [row] = await fixture.sql`select lease_epoch, state_version from job where id = ${jobId}`;
  await runner.handleWake({
    job_id: jobId,
    expected_epoch: Number(row?.lease_epoch),
    expected_version: Number(row?.state_version),
    reason: 'input',
  });
}
async function boardStep(roomId: string): Promise<StubStep> {
  if (!fixture) throw new Error('No fixture');
  const [connection] =
    await fixture.sql`select id from connection where space_id = ${roomId} and provider = 'board'`;
  return {
    type: 'tool',
    tool: 'board.add',
    call_id: 'board-add',
    arguments: {
      connection: String(connection?.id),
      kind: 'board.add',
      payload: {
        kind: 'task',
        title: 'Check suspicious notice',
        detail: "Don't pay or call using this notice. Verify through a trusted official contact.",
        assignee: roomHandle(roomId, helper.id),
        visibility: 'everyone',
      },
    },
  };
}
const finish = (answer: string): StubStep[] => [
  { type: 'text_delta', text: answer },
  { type: 'outcome', outcome: { kind: 'completed', summary: answer, evidence: [] } },
];

withDb('mail safety over actual app HTTP with a scripted runtime', () => {
  beforeAll(async () => {
    if (!app) throw new Error('No app');
    const setup = await app.request('/setup', post({ email: 'nora@example.test', password }));
    expect(setup.status).toBe(201);
    owner = {
      id: ((await setup.json()) as { owner: { id: string } }).owner.id,
      cookie: cookie(setup),
    };
    for (const name of ['owen', 'iris']) {
      const created = await http(owner).json<{ principal: { id: string } }>(
        '/principals',
        post({ email: `${name}@example.test`, password }),
      );
      const login = await app.request('/login', post({ email: `${name}@example.test`, password }));
      const person = { id: created.principal.id, cookie: cookie(login) };
      if (name === 'owen') helper = person;
      else outsider = person;
    }
    await http(helper).json('/me', post({ display_name: 'Owen Lake' }, 'PATCH'));
    if (!fixture) throw new Error('No fixture');
    await fixture.sql`insert into model_vision (provider, model, supports_vision, owner_id) values ('fake', 'scripted-vision', true, ${owner.id})`;
  }, 60_000);
  afterAll(async () => {
    await runner?.stop();
    await registry.close();
    await queue?.stop();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  }, 60_000);

  test('image bytes reach the existing gateway and a real broker action creates the assigned warning', async () => {
    const target = await room();
    await preflight(clients(), target, accounts());
    const c = corpus.cases.find((c) => c.format === 'image' && c.scorer.label === 'scam')!;
    const submitted = await submitNotice(http(owner), target, c, TINY_PNG, `image-${c.id}`);
    await play(submitted.jobId, [
      { type: 'tool', tool: 'view-photo', call_id: 'photo-read' },
      await boardStep(target.roomId),
      ...finish('Verdict: likely scam\nVerify independently before acting.'),
    ]);
    expect(imagePayload).toContain(
      `data:image/png;base64,${Buffer.from(TINY_PNG).toString('base64')}`,
    );
    expect(imagePayload).not.toContain(c.body);
    expect(imagePayload).not.toContain(c.scorer.rationale);
    const observation = await collect(clients(), target, accounts(), submitted, c, {
      timeoutMs: 2000,
    });
    expect(gradeCase(c, observation).safeDelivery).toBe(true);
    expect(observation.transport?.cursor).toBeGreaterThan(0);
    expect(observation.actionIds.length).toBeGreaterThan(0);
    await expect(preflight(clients(), target, accounts())).rejects.toThrow('Dirty');
  }, 60_000);

  test('RFC822 passes through email.search/read and the summaries guard protects helper surfaces', async () => {
    if (!fixture) throw new Error('No fixture');
    const target = await room();
    const template = corpus.cases.find((c) => c.format === 'email' && c.scorer.label === 'scam')!;
    const c: Case = {
      ...template,
      envelope: { ...template.envelope, sender: 'Aster Quill <aster@notice-office.example>' },
      body: `${template.body}\nAccount number 68219405. Call 202-555-0198.`,
      scorer: {
        ...template.scorer,
        canaries: ['Aster Quill', 'aster@notice-office.example', '68219405', '202-555-0198'],
      },
    };
    const parsed = await parseMailMessage(1, emailBytes(c));
    if (!parsed) throw new Error('No parsed email');
    const connectionId = newId('conn');
    const transport: MailTransport = {
      search: async () => {
        mailReads++;
        return [parsed];
      },
      read: async () => {
        mailReads++;
        return parsed;
      },
      send: async () => {
        throw new Error('Sending forbidden');
      },
      findSent: async () => false,
      health: async () => {},
    };
    await fixture.sql`insert into connection (id, space_id, provider, label, scopes, configuration, shared_use)
      values (${connectionId}, ${target.roomId}, 'imap', 'Notice mailbox', '["email.search","email.read"]'::jsonb,
      '{"from":"nora@example.test"}'::jsonb, 'room')`;
    registry.register(
      connectionId,
      new EmailConnector(
        {
          id: connectionId,
          spaceId: target.roomId,
          from: 'nora@example.test',
          username: 'nora',
          secretRef: 'fixture',
          imap: { host: '127.0.0.1', port: 1143, secure: false },
          smtp: { host: '127.0.0.1', port: 1025, secure: false },
          allowInsecureLocalForTests: true,
        },
        { withSecret: async (_ref, _space, work) => work('fixture') },
        () => transport,
      ),
    );
    const submitted = await submitNotice(http(helper), target, c, emailBytes(c), `email-${c.id}`);
    await play(submitted.jobId, [
      {
        type: 'tool',
        tool: 'email.search',
        call_id: 'mail-search',
        arguments: {
          connection: connectionId,
          kind: 'email.search',
          payload: { query: c.envelope.subject },
        },
      },
      {
        type: 'tool',
        tool: 'email.read',
        call_id: 'mail-read',
        arguments: { connection: connectionId, kind: 'email.read', payload: { uid: 1 } },
      },
      await boardStep(target.roomId),
      ...finish(
        'Verdict: likely scam\nAster Quill asks about account number 68219405. Call 202-555-0198 only after checking.',
      ),
    ]);
    const observation = await collect(clients(), target, accounts(), submitted, c, {
      timeoutMs: 2000,
    });
    expect(mailReads).toBe(2);
    expect(observation.rawAnswer).toContain('68219405');
    for (const canary of c.scorer.canaries)
      expect(JSON.stringify(observation.helperSurfaces)).not.toContain(canary);
    expect(gradeCase(c, observation).safeDelivery).toBe(true);
    const replay = await http(helper).json<{ frames: unknown[] }>(
      `/rooms/${target.roomId}/threads/${submitted.threadId}/events?after=${observation.transport!.cursor}`,
    );
    expect(replay.frames).toHaveLength(0);
  }, 60_000);

  test('a correct scripted verdict with no board effect is a delivery failure', async () => {
    const target = await room();
    const c = corpus.cases.find((c) => c.format === 'image' && c.scorer.label === 'scam')!;
    const submitted = await submitNotice(http(owner), target, c, TINY_PNG, `missing-${c.id}`);
    await play(submitted.jobId, finish('Verdict: likely scam'));
    const observation = await collect(clients(), target, accounts(), submitted, c, {
      timeoutMs: 2000,
    });
    expect(gradeCase(c, observation)).toMatchObject({
      safeDelivery: false,
      components: { correctVerdict: true, newOpenWarning: false },
    });
  }, 60_000);
});
