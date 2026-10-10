/**
 * Deleting a chat takes the files it alone made out of its computer's shared
 * `/work`, against Postgres, the fake sandbox and a real work folder.
 *
 * - A chat's own file goes; a file another chat also wrote stays, and so does
 *   every file of the chats that are left.
 * - The same file leaves another chat's copy of `/work`, so that chat's next
 *   command does not send it back.
 * - A stopped computer is not started to be cleaned; it is cleaned when it
 *   next starts.
 * - Nothing outside `/work`, and nothing reached through a link, is removed.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Action, canonicalizePayload, type SandboxConnectionConfig } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { createSandboxExecConnector } from '../../src/connectors/sandbox-exec.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { openDatabase } from '../../src/db/client.ts';
import { removeJobs } from '../../src/experience/removal.ts';
import { QUEUES } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FakeSandboxEngine, FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { seedSessionScope } from '../../src/sandbox/session-fixtures.ts';
import { SandboxSessions } from '../../src/sandbox/sessions.ts';
import { cleanRunningComputers, removeQueuedWork } from '../../src/sandbox/work-files.ts';
import { createTestDatabase } from './postgres.ts';

const db = await createTestDatabase();
const handle = db ? openDatabase(db.url, 2) : null;
const jobs = handle && db ? new JobService(handle.db, db.boss) : null;
if (db) for (const queue of Object.values(QUEUES)) await db.boss.createQueue(queue);
const withDb = db ? describe : describe.skip;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// One engine for the file, so sandbox ids never repeat in its database.
const engine = new FakeSandboxEngine();

let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'melete-chat-work-'));
});
afterAll(async () => {
  await handle?.sql.end({ timeout: 2 });
  await db?.close();
}, 30_000);

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const config: SandboxConnectionConfig = {
  adapter: 'e2b',
  image: 'base',
  egress: 'deny_all',
  persistence: 'pause',
  lifetime_seconds: 600,
};

async function setup() {
  if (!db) throw new Error('Postgres is unavailable');
  const { sql } = db;
  const scope = await seedSessionScope(sql);
  const workRoot = path.join(root, 'work');
  const provider = new FakeSandboxProvider({ engine });
  const sessions = new SandboxSessions(sql, {
    leaseSeconds: 300,
    workspaceRetentionSeconds: 3_600,
  });
  const connector = createSandboxExecConnector({
    sessions,
    provider,
    config,
    connectionId: scope.connectionId,
    spaceId: scope.spaceId,
    project: 'chat-delete-work-files',
    workRoot,
    sql,
  });
  /** A chat of the scope's agent, with its own copy of /work here. */
  const chat = async (title: string) => {
    const id = recordId('job');
    await sql`insert into job (id, space_id, agent_id, title, objective)
      values (${id}, ${scope.spaceId}, ${scope.agentId}, ${title}, 'Work')`;
    await mkdir(path.join(workRoot, id), { recursive: true });
    let epoch = 0;
    return {
      id,
      /** A fresh attempt, as each turn of the chat has. */
      async attempt() {
        epoch += 1;
        const attemptId = recordId('att');
        await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
          values (${attemptId}, ${id}, ${epoch}, 'fake', 'fake', 'scripted')`;
        return attemptId;
      },
    };
  };
  /** Runs a command the way the broker does: dispatched, executed, settled. */
  const run = async (jobId: string, attemptId: string, command: string) => {
    const id = recordId('act');
    const canonical = canonicalizePayload({ command });
    await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, idempotency_key, status, dispatched_at)
      values (${id}, ${jobId}, ${attemptId}, ${scope.connectionId}, 'terminal.run',
        'write_reversible', ${JSON.stringify(canonical.canonical)}::jsonb, ${canonical.hash}, ${id},
        'dispatched', now())`;
    const action: Action = {
      id,
      job_id: jobId,
      attempt_id: attemptId,
      connection_id: scope.connectionId,
      kind: 'terminal.run',
      effect_class: 'write_reversible',
      canonical_payload: canonical.canonical,
      payload_hash: canonical.hash,
      intent_key: null,
      status: 'dispatched',
      authorization_ref: null,
      budget_reservation: null,
      idempotency_key: id,
      dispatched_at: new Date().toISOString(),
      receipt: null,
      resolved_at: null,
      reconciliation: null,
      repair_trace: [],
      repair_counters: {},
      repair_disposition: null,
      retry_after_at: null,
      created_at: new Date().toISOString(),
    };
    const context: ConnectorContext = {
      job_id: jobId,
      space_id: scope.spaceId,
      idempotency_key: id,
      constraints: {
        deliverable: { kind: 'none' },
        allowed_domains: [],
        public_compartment: false,
      },
    };
    const outcome = await connector.execute(action, context);
    if (outcome.outcome !== 'succeeded') throw new Error(JSON.stringify(outcome));
    await sql`update action set status = 'succeeded', resolved_at = now() where id = ${id}`;
    return {
      sessionId: String(outcome.receipt.detail.session_id),
      output: String(outcome.receipt.detail.output ?? ''),
    };
  };
  const suspend = (sessionId: string) =>
    sessions.suspendWorkspace(sessionId, provider, AbortSignal.timeout(10_000));
  const remove = (jobId: string) => {
    if (!jobs) throw new Error('Postgres is unavailable');
    return removeJobs({ jobs, sql, workspaces: { workRoot, days: 7 } }, [jobId]);
  };
  const sweep = () =>
    cleanRunningComputers(
      sql,
      () => provider,
      AbortSignal.timeout(10_000),
      () => {},
    );
  return { sql, scope, provider, sessions, workRoot, chat, run, suspend, remove, sweep };
}

withDb('deleting a chat and the files it made in /work', () => {
  test("its own files go; a file another chat also wrote stays, and so do the other chat's", async () => {
    const s = await setup();
    const first = await s.chat('First');
    const second = await s.chat('Second');
    // A file the first chat saved with its file tools, in its own copy of /work.
    await writeFile(path.join(s.workRoot, first.id, 'saved.md'), 'saved');
    const made = await s.run(
      first.id,
      await first.attempt(),
      'printf report > /work/report.pdf; mkdir -p /work/pages; printf page > /work/pages/one.html; printf first > /work/notes.txt',
    );
    await s.suspend(made.sessionId);
    // The second chat changes the shared notes and makes a file of its own.
    const turn = await second.attempt();
    const later = await s.run(
      second.id,
      turn,
      `printf second >> /work/notes.txt; printf mine > /work/mine.txt; find /work -mindepth 1 -printf '%P\n'`,
    );
    expect(later.output).toContain('report.pdf');
    // The second chat's copy of /work now holds the first chat's file too.
    expect(await exists(path.join(s.workRoot, second.id, 'report.pdf'))).toBe(true);

    const removal = await s.remove(first.id);
    expect(removal.computer_files).toEqual({ removed: 3, kept: 1 });
    // The computer is running: the sweep cleans it.
    expect(await s.sweep()).toBe(3);
    const listed = await s.run(
      second.id,
      turn,
      `find /work -mindepth 1 -printf '%P\n'; cat /work/notes.txt`,
    );
    expect(listed.output).not.toContain('report.pdf');
    expect(listed.output).not.toContain('one.html');
    expect(listed.output).not.toContain('saved.md');
    expect(listed.output).toContain('mine.txt');
    expect(listed.output).toContain('firstsecond');
    // Out of the other chat's copy too, so its commands do not send it back.
    expect(await exists(path.join(s.workRoot, second.id, 'report.pdf'))).toBe(false);
    expect(await exists(path.join(s.workRoot, second.id, 'mine.txt'))).toBe(true);
    const [left] = await s.sql`select count(*)::int as n from sandbox_work_removal
      where space_id = ${s.scope.spaceId}`;
    expect(left?.n).toBe(0);
  }, 90_000);

  test('a file another chat changed after it was made stays', async () => {
    const s = await setup();
    const first = await s.chat('First');
    const second = await s.chat('Second');
    const made = await s.run(first.id, await first.attempt(), 'printf draft > /work/draft.md');
    await s.suspend(made.sessionId);
    const turn = await second.attempt();
    await s.run(second.id, turn, 'printf edited > /work/draft.md');
    const removal = await s.remove(first.id);
    // Two chats wrote it: it is shared, so it is not queued at all.
    expect(removal.computer_files).toEqual({ removed: 0, kept: 1 });
    await s.sweep();
    const after = await s.run(second.id, turn, 'cat /work/draft.md');
    expect(after.output).toBe('edited');
  }, 90_000);

  test('a stopped computer is not started to be cleaned, and is cleaned when it next starts', async () => {
    const s = await setup();
    const first = await s.chat('First');
    const second = await s.chat('Second');
    const made = await s.run(
      first.id,
      await first.attempt(),
      'printf scraped > /work/scraped.html',
    );
    await s.suspend(made.sessionId);
    const removal = await s.remove(first.id);
    expect(removal.computer_files.removed).toBe(1);
    const resumes = s.provider.calls.resume;
    const creates = s.provider.calls.create;
    expect(await s.sweep()).toBe(0);
    // Nothing started the computer for this.
    expect(s.provider.calls.resume).toBe(resumes);
    expect(s.provider.calls.create).toBe(creates);
    const [queued] = await s.sql`select count(*)::int as n from sandbox_work_removal
      where space_id = ${s.scope.spaceId}`;
    expect(queued?.n).toBe(1);
    // The next chat to use it starts it, and the file is gone before its command runs.
    const next = await s.run(
      second.id,
      await second.attempt(),
      `find /work -mindepth 1 -printf '%P\n'`,
    );
    expect(s.provider.calls.resume).toBe(resumes + 1);
    expect(next.output).not.toContain('scraped.html');
    const [left] = await s.sql`select count(*)::int as n from sandbox_work_removal
      where space_id = ${s.scope.spaceId}`;
    expect(left?.n).toBe(0);
  }, 90_000);

  test('nothing outside /work, and nothing reached through a link, is ever removed', async () => {
    if (!db) throw new Error('Postgres is unavailable');
    const { sql } = db;
    const scope = await seedSessionScope(sql);
    const provider = new FakeSandboxProvider({ engine });
    const sandbox = await provider.create(
      {
        image: 'base',
        egress: { kind: 'deny_all' },
        region: null,
        lifetimeSeconds: 60,
        idleSeconds: null,
        workdir: '/work',
        labels: {},
        env: {},
      },
      AbortSignal.timeout(5_000),
    );
    const sh = async (command: string) => {
      const ran = await provider.exec(
        sandbox,
        {
          marker: recordId('act'),
          argv: ['sh', '-c', command],
          cwd: '/',
          timeoutMs: 5_000,
          maxOutputBytes: 65_536,
        },
        AbortSignal.timeout(5_000),
      );
      return new TextDecoder().decode(ran.output);
    };
    await sh(
      [
        'mkdir -p /work /outside',
        'printf secret > /outside/secret.txt',
        'printf secret > /outside/other.txt',
        'ln -s /outside /work/link',
        'ln -s /outside/other.txt /work/escape.txt',
        'printf secret > /work/own.txt',
      ].join('; '),
    );
    const computer = {
      spaceId: scope.spaceId,
      agentId: scope.agentId,
      connectionId: scope.connectionId,
      providerSandboxId: sandbox.providerSandboxId,
    };
    const hash = digest('secret');
    for (const queued of [
      '../outside/secret.txt',
      '/outside/secret.txt',
      'link/secret.txt',
      'link',
      'escape.txt',
      'own.txt',
    ])
      await sql`insert into sandbox_work_removal
          (id, space_id, agent_id, connection_id, job_id, path, hash)
        values (${recordId('wrm')}, ${scope.spaceId}, ${scope.agentId}, ${scope.connectionId},
          ${recordId('job')}, ${queued}, ${hash})`;

    const outcome = await removeQueuedWork(
      sql,
      provider,
      sandbox,
      computer,
      AbortSignal.timeout(10_000),
    );
    // Only the regular file inside /work went.
    expect(outcome.removed).toEqual(['own.txt']);
    expect(await sh('cat /outside/secret.txt /outside/other.txt')).toBe('secretsecret');
    expect(await sh('cat /work/link/secret.txt /work/escape.txt')).toBe('secretsecret');
    expect(await sh('test -e /work/own.txt && printf here || printf gone')).toBe('gone');
    const [left] = await sql`select count(*)::int as n from sandbox_work_removal
      where space_id = ${scope.spaceId}`;
    expect(left?.n).toBe(0);
    await rm(root, { recursive: true, force: true });
  }, 60_000);
});
