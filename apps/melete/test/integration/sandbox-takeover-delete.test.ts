/**
 * After a takeover, a process the earlier conversation left running in the
 * agent's computer keeps the session row it started under, and the new
 * conversation gets a row of its own. A command of the new conversation that
 * deletes files then applies none of those deletes on the host: the old
 * process, not the command, may be what removed them.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordId } from '../../src/broker/records.ts';
import { fileRecords } from '../../src/connectors/files-ownership.ts';
import { deleteRule, othersRunningOn } from '../../src/connectors/sandbox-exec.ts';
import { FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { seedSessionScope } from '../../src/sandbox/session-fixtures.ts';
import { syncIn, syncOut } from '../../src/sandbox/workspace.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

databaseTest(
  "an earlier conversation's process still running after a takeover stops the new one's deletes",
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { sql } = fixture;
    const scope = await seedSessionScope(sql);
    // Conversation A held the computer and left a process running in it.
    const earlier = scope.jobId;
    const attemptA = await scope.attempt();
    const sandbox = `melete-sbx-test-${recordId('sbx').toLowerCase()}`;
    const session = async (id: string, jobId: string, attemptId: string, status: string) =>
      sql`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id, agent_id,
          adapter, provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
        values (${id}, ${scope.connectionId}, ${scope.spaceId}, ${jobId}, ${attemptId},
          ${scope.agentId}, 'docker', ${sandbox}, 'melete-sandbox:local', '{"kind":"open"}'::jsonb,
          'pause', ${status}, now() + interval '1 hour')`;
    const old = recordId('sbx');
    await session(old, earlier, attemptA, 'closed');
    await sql`insert into sandbox_process (id, space_id, agent_id, connection_id, job_id, session_id,
        command_redacted, command_digest, cwd, name, state, expires_at)
      values (${recordId('prc')}, ${scope.spaceId}, ${scope.agentId}, ${scope.connectionId}, ${earlier},
        ${old}, 'while true; do rm -rf /work/*; sleep 1; done', 'd', '/work', 'loop', 'running',
        now() + interval '1 hour')`;
    // Conversation B takes the computer over: a new session row of its own.
    const later = recordId('job');
    await sql`insert into job (id, space_id, title, objective) values (${later}, ${scope.spaceId}, 'B', 'Run')`;
    const attemptB = recordId('att');
    await sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
      values (${attemptB}, ${later}, 1, 'fake', 'fake', 'scripted')`;
    const current = recordId('sbx');
    await session(current, later, attemptB, 'ready');
    const computer = {
      id: current,
      spaceId: scope.spaceId,
      agentId: scope.agentId,
      connectionId: scope.connectionId,
    };

    // The session row alone would not see it; the computer does.
    const [byRow] = await sql`select count(*)::int as live from sandbox_process
      where session_id = ${current} and state = 'running'`;
    expect(byRow?.live).toBe(0);
    expect(await othersRunningOn(sql, computer, later)).toBe(true);
    // Its own processes are not another conversation's.
    expect(await othersRunningOn(sql, computer, earlier)).toBe(false);

    // B's command deletes a file; nothing is deleted on the host.
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-takeover-')));
    try {
      await mkdir(path.join(root, 'work', later), { recursive: true });
      await writeFile(path.join(root, 'work', later, 'notes.md'), 'B made this');
      const provider = new FakeSandboxProvider();
      const handle = await provider.create(
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
      const options = {
        provider,
        handle,
        workRoot: path.join(root, 'work'),
        jobId: later,
        signal: AbortSignal.timeout(10_000),
      };
      const { sent } = await syncIn(options);
      await provider.exec(
        handle,
        {
          marker: 'act_1',
          argv: ['sh', '-c', 'rm -f /work/notes.md'],
          cwd: '/work',
          timeoutMs: 5_000,
          maxOutputBytes: 4096,
        },
        AbortSignal.timeout(5_000),
      );
      const report = await syncOut({
        ...options,
        deletions: {
          sent,
          keep: deleteRule({
            records: fileRecords([]),
            othersRunning: await othersRunningOn(sql, computer, later),
          }),
        },
      });
      expect(report.deleted).toEqual([]);
      expect(report.kept[0]?.reason).toContain('another conversation started is still running');
      expect(await readFile(path.join(root, 'work', later, 'notes.md'), 'utf8')).toBe(
        'B made this',
      );
      expect(existsSync(path.join(root, 'work', '.trash'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
