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
import {
  cleanRunningComputers,
  readStart,
  recordWorkFiles,
  removeQueuedWork,
  type WorkComputer,
} from '../../src/sandbox/work-files.ts';
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
    // The turn's first read-back counts the computer being handed over, so
    // the edit comes in a second command, read back with nobody else at work.
    await s.run(second.id, turn, 'true');
    await s.run(second.id, turn, 'printf edited > /work/draft.md; printf own > /work/own.md');
    const recorded = async (file: string) => {
      const [row] = await s.sql`select writers, shared from sandbox_work_file
        where space_id = ${s.scope.spaceId} and path = ${file}`;
      return row ? { writers: row.writers, shared: row.shared } : null;
    };
    // That read-back was clean: the new file is the second chat's alone, and
    // the edited one is shared because both chats wrote it.
    expect(await recorded('own.md')).toEqual({ writers: [second.id], shared: false });
    expect(await recorded('draft.md')).toEqual({ writers: [first.id, second.id], shared: true });
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

withDb('who made a file in /work', () => {
  async function scope() {
    if (!db) throw new Error('Postgres is unavailable');
    const { sql } = db;
    const seeded = await seedSessionScope(sql);
    const computer: WorkComputer = {
      spaceId: seeded.spaceId,
      agentId: seeded.agentId,
      connectionId: seeded.connectionId,
      providerSandboxId: recordId('sbx'),
    };
    const chat = async () => {
      const id = recordId('job');
      await sql`insert into job (id, space_id, agent_id, title, objective)
        values (${id}, ${seeded.spaceId}, ${seeded.agentId}, 'Chat', 'Work')`;
      return id;
    };
    // Records start with an empty /work.
    await sql`insert into sandbox_work_read (space_id, agent_id, connection_id)
      values (${seeded.spaceId}, ${seeded.agentId}, ${seeded.connectionId})`;
    /** One command's read-back: what /work holds, and what the chat's own copy sent. */
    const readBack = async (
      jobId: string,
      files: Record<string, string>,
      sent: Record<string, string> = {},
    ) => {
      const from = await readStart(sql);
      if (!from) throw new Error('the database gave no time');
      const hashes = new Map(Object.entries(files).map(([file, body]) => [file, digest(body)]));
      const copy = new Map(
        Object.entries(sent).map(([file, body]) => [
          file,
          { size: body.length, hash: digest(body) },
        ]),
      );
      await recordWorkFiles(sql, computer, jobId, from, hashes, copy, () => true);
    };
    const recorded = async (file: string) => {
      const [row] = await sql`select writers, shared from sandbox_work_file
        where space_id = ${seeded.spaceId} and path = ${file}`;
      return row ? { writers: row.writers as string[], shared: row.shared as boolean } : null;
    };
    /** Another chat's command on the computer, under way until settled. */
    const command = async (jobId: string) => {
      const id = recordId('act');
      const attemptId = recordId('att');
      await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
        values (${attemptId}, ${jobId}, 1, 'fake', 'fake', 'scripted')`;
      await sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status, dispatched_at)
        values (${id}, ${jobId}, ${attemptId}, ${seeded.connectionId}, 'terminal.run',
          'write_reversible', '{}'::jsonb, 'hash', ${id}, 'dispatched', now())`;
      return async () => {
        await sql`update action set status = 'succeeded', resolved_at = now() where id = ${id}`;
      };
    };
    return { sql, seeded, computer, chat, readBack, recorded, command };
  }

  test("after another chat's command overlapped, the next clean read-back is the chat's again", async () => {
    const s = await scope();
    const mine = await s.chat();
    const other = await s.chat();
    const settle = await s.command(other);
    await s.readBack(mine, { 'a.txt': 'a' });
    expect(await s.recorded('a.txt')).toEqual({ writers: [], shared: true });
    await settle();
    // It ended after the last read-back began: still counted once.
    await s.readBack(mine, { 'a.txt': 'a', 'b.txt': 'b' });
    expect((await s.recorded('b.txt'))?.shared).toBe(true);
    // Nothing else has been at work since: the chat's alone.
    await s.readBack(mine, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    expect(await s.recorded('c.txt')).toEqual({ writers: [mine], shared: false });
  }, 30_000);

  test('a person holding a display keeps every change shared until they hand it back', async () => {
    const s = await scope();
    const mine = await s.chat();
    const display = `${s.computer.providerSandboxId}#1`;
    // Taken over before records started, and still held.
    await s.sql`insert into sandbox_control (provider_sandbox_id, control, epoch, changed_at)
      values (${display}, 'human', 1, now() - interval '1 hour')`;
    await s.readBack(mine, { 'a.txt': 'a' });
    await s.readBack(mine, { 'a.txt': 'a', 'b.txt': 'b' });
    expect((await s.recorded('a.txt'))?.shared).toBe(true);
    expect((await s.recorded('b.txt'))?.shared).toBe(true);
    await s.sql`update sandbox_control set control = 'agent', epoch = 2, changed_at = now()
      where provider_sandbox_id = ${display}`;
    await s.readBack(mine, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    expect((await s.recorded('c.txt'))?.shared).toBe(true);
    await s.readBack(mine, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'd.txt': 'd' });
    expect(await s.recorded('d.txt')).toEqual({ writers: [mine], shared: false });
  }, 30_000);

  test('a takeover of the sandbox the computer was before it was made again counts', async () => {
    const s = await scope();
    const mine = await s.chat();
    const before = recordId('sbx');
    await s.sql`insert into sandbox_session (id, connection_id, space_id, agent_id, adapter,
        provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at, closed_at)
      values (${recordId('sbs')}, ${s.seeded.connectionId}, ${s.seeded.spaceId}, ${s.seeded.agentId},
        'fake', ${before}, 'base', '{"kind":"deny_all"}'::jsonb, 'pause', 'closed', now(), now())`;
    // The person took the old sandbox over and handed it back since the last read-back.
    await s.sql`insert into sandbox_control (provider_sandbox_id, control, epoch, changed_at)
      values (${before}, 'agent', 2, now())`;
    await s.readBack(mine, { 'notes.md': 'theirs' });
    expect((await s.recorded('notes.md'))?.shared).toBe(true);
  }, 30_000);
});
