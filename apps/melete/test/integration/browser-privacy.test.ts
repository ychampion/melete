import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  dedupKey,
  type JsonObject,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { event, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { type AttemptWake, QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'browser-privacy-integration-signing-key-32-bytes';
const credential = 'fixture-password-and-factor-072614';
const sessionId = 'brws_00000000-0000-4000-8000-000000000001';
const runners: AttemptRunner[] = [];
let spaceId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

function worker(runtime: RuntimeAdapter = new StubRuntimeAdapter(), service = fixture().jobs) {
  const value = new AttemptRunner(service, runtime, { key });
  runners.push(value);
  return value;
}

function wake(row: JobRow): AttemptWake {
  return {
    job_id: row.id,
    expected_epoch: row.leaseEpoch,
    expected_version: row.stateVersion,
    reason: 'created',
  };
}

function create() {
  return fixture().jobs.create({
    space_id: spaceId,
    title: 'Browser privacy',
    objective: 'Use the browser after human sign-in',
  });
}

async function claim(runner: AttemptRunner, row: JobRow): Promise<ClaimedAttempt> {
  const result = await runner.claim(wake(row));
  if (!result) throw new Error('Expected an admitted attempt');
  return result;
}

function input(claimed: ClaimedAttempt, localSeq: number, body: object): RuntimeEvent {
  return {
    ...body,
    attempt_id: claimed.claims.attempt_id,
    local_seq: localSeq,
    dedup_key: dedupKey(claimed.claims.attempt_id, localSeq),
    at: new Date().toISOString(),
  } as RuntimeEvent;
}

async function savedEvents(jobId: string) {
  return fixture().handle.db.select().from(event).where(eq(event.jobId, jobId));
}

withDb('browser episode privacy against Postgres and pg-boss', () => {
  beforeEach(async () => {
    const { handle, queue } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.recoveryScan);
    await handle.sql`truncate "owner", "space" cascade`;
    spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  });

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.stop();
  });

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('durable browser identity redacts a password fill and forged result after runner restart, including the next transcript', async () => {
    const { handle, queue } = fixture();
    const firstRunner = worker();
    const row = await create();
    const admitted = await claim(firstRunner, row);
    const proposal = input(admitted, 0, {
      type: 'tool_call_proposed',
      tool: 'browser.fill',
      call_id: 'password-fill',
      arguments: { session_id: sessionId, control_epoch: 0, label: 'Password', value: credential },
    });
    await firstRunner.emit(admitted.claims, proposal);
    await firstRunner.stop();
    const restartedJobs = new JobService(handle.db, queue.boss);
    const restarted = worker(undefined, restartedJobs);
    const artifactId = newId('art');
    await restarted.emit(
      admitted.claims,
      input(admitted, 1, {
        type: 'tool_result',
        call_id: 'password-fill',
        ok: false,
        result: {
          error: { message: credential },
          receipt: {
            detail: {
              session_id: sessionId,
              control_epoch: 0,
              observation: {
                tree: { artifact_id: artifactId, path: credential },
                url: `https://public.example/?code=${credential}`,
              },
              result: { text: credential, submit_intents: [{ fields: { password: credential } }] },
            },
          },
        },
      }),
    );
    const persisted = await savedEvents(row.id);
    expect(JSON.stringify(persisted)).not.toContain(credential);
    expect(persisted.find((entry) => entry.type === 'tool_call_proposed')?.payload).toMatchObject({
      call_id: 'password-fill',
      tool: 'browser.fill',
      arguments: { redacted: true },
    });
    expect(persisted.find((entry) => entry.type === 'tool_result')?.payload).toMatchObject({
      call_id: 'password-fill',
      ok: false,
      result: {
        redacted: true,
        receipt: {
          detail: {
            session_id: sessionId,
            control_epoch: 0,
            observation: { tree: { artifact_id: artifactId } },
          },
        },
      },
    });
    if (proposal.type !== 'tool_call_proposed') throw new Error('expected proposal');
    expect(proposal.arguments.value).toBe(credential);
    await restarted.commitOutcome(admitted.claims, {
      kind: 'waiting_for_input',
      question: 'Sign in using human control.',
    });
    const resumed = await restartedJobs.input(row.id, 'Continue after human sign-in.');
    const next = await claim(worker(undefined, new JobService(handle.db, queue.boss)), resumed);
    const message = next.bundle.transcript.find((entry) => entry.tool_call_id === 'password-fill');
    expect(message?.content).toContain('redacted');
    expect(message?.content).toContain(artifactId);
    expect(JSON.stringify(next.bundle.transcript)).not.toContain(credential);
    expect(JSON.stringify(await savedEvents(row.id))).not.toContain(credential);
  });

  test('late browser results redact both the receipt notice and tool-result event after cancellation', async () => {
    const { jobs } = fixture();
    const first = worker();
    const row = await create();
    const admitted = await claim(first, row);
    await first.emit(
      admitted.claims,
      input(admitted, 0, {
        type: 'tool_call_proposed',
        tool: 'browser.fill',
        call_id: 'late-password',
        arguments: { label: 'Authentication code', value: credential },
      }),
    );
    await jobs.cancel(row.id);
    await worker().emit(
      admitted.claims,
      input(admitted, 1, {
        type: 'tool_result',
        call_id: 'late-password',
        ok: false,
        result: { text: credential, session_id: sessionId, control_epoch: 1 },
      }),
    );
    const stored = await savedEvents(row.id);
    expect(JSON.stringify(stored)).not.toContain(credential);
    const receipt = stored.find(
      (entry) => entry.type === 'notice' && (entry.payload as JsonObject).kind === 'receipt',
    );
    expect(receipt?.payload).toMatchObject({
      late: true,
      result: { redacted: true, session_id: sessionId, control_epoch: 1 },
    });
    expect(stored.find((entry) => entry.type === 'tool_result')?.payload).toMatchObject({
      late: true,
      result: { redacted: true },
    });
    expect((await jobs.get(row.id)).state).toBe('cancelled');
  });

  test('call-ID shadowing cannot remove browser redaction while unrelated tools remain unchanged', async () => {
    const runner = worker();
    const row = await create();
    const admitted = await claim(runner, row);
    await runner.emit(
      admitted.claims,
      input(admitted, 0, {
        type: 'tool_call_proposed',
        tool: 'browser.read',
        call_id: 'shared',
        arguments: { selector: credential },
      }),
    );
    await runner.emit(
      admitted.claims,
      input(admitted, 1, {
        type: 'tool_call_proposed',
        tool: 'test.read',
        call_id: 'shared',
        arguments: {},
      }),
    );
    await runner.emit(
      admitted.claims,
      input(admitted, 2, {
        type: 'tool_result',
        call_id: 'shared',
        ok: true,
        result: { tool: 'test.read', text: credential },
      }),
    );
    await runner.emit(
      admitted.claims,
      input(admitted, 3, {
        type: 'tool_call_proposed',
        tool: 'test.read',
        call_id: 'ordinary',
        arguments: { query: 'ordinary input' },
      }),
    );
    await runner.emit(
      admitted.claims,
      input(admitted, 4, {
        type: 'tool_result',
        call_id: 'ordinary',
        ok: true,
        result: { text: 'ordinary result', nested: { preserved: true } },
      }),
    );
    const stored = await savedEvents(row.id);
    expect(JSON.stringify(stored)).not.toContain(credential);
    expect(
      stored.find(
        (entry) =>
          entry.type === 'tool_result' && (entry.payload as JsonObject).call_id === 'shared',
      )?.payload,
    ).toMatchObject({ result: { redacted: true } });
    expect(
      stored.find(
        (entry) =>
          entry.type === 'tool_call_proposed' &&
          (entry.payload as JsonObject).call_id === 'ordinary',
      )?.payload,
    ).toMatchObject({ arguments: { query: 'ordinary input' } });
    expect(
      stored.find(
        (entry) =>
          entry.type === 'tool_result' && (entry.payload as JsonObject).call_id === 'ordinary',
      )?.payload,
    ).toMatchObject({ result: { text: 'ordinary result', nested: { preserved: true } } });
  });

  test('scripted execution receives original input even though its event and result copies are redacted', async () => {
    let executed: JsonObject | undefined;
    const stub = new StubRuntimeAdapter({
      onTool: (_id, args) => {
        executed = args;
        return {
          status: 'failed',
          text: args.value ?? null,
          session_id: sessionId,
          control_epoch: 0,
        };
      },
    });
    const scripted: RuntimeAdapter = {
      capabilities: () => stub.capabilities(),
      start: (bundle, sink, signal) =>
        stub.start(
          {
            ...bundle,
            job: {
              ...bundle.job,
              constraints: {
                ...bundle.job.constraints,
                script: [
                  {
                    type: 'tool',
                    tool: 'browser.fill',
                    call_id: 'scripted-password',
                    arguments: { label: 'Password', value: credential },
                  },
                  {
                    type: 'outcome',
                    outcome: {
                      kind: 'waiting_for_input',
                      question: 'Use human control to sign in.',
                    },
                  },
                ],
              },
            },
          },
          sink,
          signal,
        ),
    };
    const row = await create();
    await worker(scripted).handleWake(wake(row));
    expect(executed).toEqual({ label: 'Password', value: credential });
    expect(JSON.stringify(await savedEvents(row.id))).not.toContain(credential);
    expect((await fixture().jobs.get(row.id)).state).toBe('waiting_for_input');
  }, 10_000);
});
