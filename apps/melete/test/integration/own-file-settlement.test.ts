/**
 * A file step's outcome is settled from what is on disk, and an open one never
 * holds up the conversation.
 *
 * A file in the agent's workspace or the person's Files cannot have gone
 * anywhere, so whether a write happened is a question the disk answers: the
 * file is there with exactly the bytes asked for, or it is not. The person is
 * never asked, and the job never rests in reconciliation over one.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DispatchResult } from '@melete/contracts';
import { createArtifactRecorder } from '../../src/artifact/record.ts';
import { BrokerService, OWN_COMPUTER_UNKNOWN } from '../../src/broker/service.ts';
import { createFilesConnector, settledFromDisk } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

const CSV = 'city,population\nHouston,2397315\nSan Antonio,1548422\nTotal,3945737\n';

async function setup(wrap: (files: Connector) => Connector = (files) => files) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const seed = await seedJob(sql, { scopes: ['files.write', 'files.read'], provider: 'files' });
  const roots = await mkdtemp(path.join(tmpdir(), 'melete-own-files-'));
  const workRoot = path.join(roots, 'work');
  const spacesRoot = path.join(roots, 'spaces');
  await Bun.write(path.join(workRoot, seed.claims.job_id, '.keep'), '');
  await Bun.write(path.join(spacesRoot, seed.claims.space_id, 'artifacts', '.keep'), '');
  const files = createFilesConnector({ workRoot, spacesRoot });
  const broker = new BrokerService({
    sql,
    connectors: new ConnectorRegistry().register(seed.connectionId, wrap(files)),
    recordArtifact: createArtifactRecorder(undefined, { workRoot, spacesRoot }),
    dispatchTimeoutMs: 300,
  });
  const write = (payload: Record<string, unknown>) =>
    broker.propose(seed.claims, {
      kind: 'files.write',
      connection_id: seed.connectionId,
      payload,
    });
  const state = async () => {
    const [job] = await sql`select state from job where id = ${seed.claims.job_id}`;
    const [asked] =
      await sql`select count(*)::int as count from question where job_id = ${seed.claims.job_id}`;
    return { job: job?.state as string, questions: Number(asked?.count ?? 0) };
  };
  const status = async (id: string) =>
    String((await sql`select status from action where id = ${id}`)[0]?.status);
  return { ...seed, sql, files, write, state, status, spacesRoot };
}

databaseTest(
  'a CSV saved with a declared parses check is a saved file, with its checks recorded',
  async () => {
    const ctx = await setup();
    const result = await ctx.write({
      path: 'p-texas-cities.csv',
      area: 'artifacts',
      content: CSV,
      expect: { kind: 'csv', checks: [{ kind: 'parses' }, { kind: 'non_empty' }] },
    });
    expect(result.status).toBe('succeeded');
    const names = await ctx.sql`select v.name from artifact_validation v
      join artifact a on a.id = v.artifact_id where a.job_id = ${ctx.claims.job_id}`;
    expect(names.map((row) => row.name).sort()).toEqual(['csv.parses', 'non_empty', 'render:csv']);
    expect(await ctx.state()).toEqual({ job: 'running', questions: 0 });
  },
  SLOW,
);

databaseTest(
  'a write that throws after its bytes landed settles as succeeded from the file on disk',
  async () => {
    const ctx = await setup((files) =>
      settledFromDisk({
        ...files,
        async execute(action, context) {
          await files.execute(action, context);
          throw new Error('a check after the write failed');
        },
      }),
    );
    const result = await ctx.write({ path: 'notes.txt', content: 'stretch at 14:44' });
    expect(result.status).toBe('succeeded');
    expect(await ctx.state()).toEqual({ job: 'running', questions: 0 });
  },
  SLOW,
);

databaseTest(
  'a write whose bytes are not there stays open, for the agent to check, and asks nobody',
  async () => {
    const ctx = await setup((files) =>
      settledFromDisk({
        ...files,
        async execute() {
          throw new Error('lost before anything was written');
        },
      }),
    );
    const result = await ctx.write({ path: 'never.txt', content: 'not written' });
    expect(result.status).toBe('unknown');
    expect(result.own_computer).toBe(true);
    expect(result.message).toBe(OWN_COMPUTER_UNKNOWN);
    expect(await ctx.state()).toEqual({ job: 'running', questions: 0 });
  },
  SLOW,
);

databaseTest(
  'a write whose answer comes back after the dispatch timeout lands as succeeded, and never blocks the job',
  async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered: (result: DispatchResult) => void = () => {};
    const late = new Promise<DispatchResult>((resolve) => {
      answered = resolve;
    });
    const ctx = await setup((files) => ({
      ...files,
      async execute(action, context) {
        // The bytes land at once; the answer is held past the broker's timeout.
        const result = await files.execute(action, context);
        await released;
        answered(result);
        return result;
      },
    }));
    const result = await ctx.write({ path: 'slow.csv', content: CSV });
    // The broker stopped waiting: the outcome is open, and the agent is told to check.
    expect(result.status).toBe('unknown');
    expect(result.message).toBe(OWN_COMPUTER_UNKNOWN);
    expect(await ctx.state()).toEqual({ job: 'running', questions: 0 });
    release();
    expect((await late).outcome).toBe('succeeded');
    const deadline = Date.now() + 10_000;
    while ((await ctx.status(result.action_id)) !== 'succeeded' && Date.now() < deadline)
      await Bun.sleep(50);
    expect(await ctx.status(result.action_id)).toBe('succeeded');
    expect(await ctx.state()).toEqual({ job: 'running', questions: 0 });
  },
  SLOW,
);
