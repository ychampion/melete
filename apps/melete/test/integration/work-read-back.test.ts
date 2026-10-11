/**
 * Through the ledger: what a command's read-back left on the agent's computer
 * is on its receipt, and a later move into Files of one of those paths fails
 * with that reason; a move of a file that did come back removes the
 * computer's copy on the computer the step has running, and says so when no
 * computer is running.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jobConstraints } from '@melete/contracts';
import { recordId } from '../../src/broker/records.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { workspaceNote } from '../../src/connectors/sandbox-exec.ts';
import { connectorAction } from '../../src/connectors/test-fixtures.ts';
import { FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { leftOnComputer, removeMovedFromComputers } from '../../src/sandbox/move-out.ts';
import { seedSessionScope } from '../../src/sandbox/session-fixtures.ts';
import { syncOut } from '../../src/sandbox/workspace.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

databaseTest(
  'a skipped path fails a move with its reason, and a moved file leaves the running computer',
  async () => {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const { sql } = fixture;
    const scope = await seedSessionScope(sql);
    const attempt = await scope.attempt();
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'melete-read-back-db-')));
    try {
      await mkdir(path.join(root, 'work'), { recursive: true });
      await mkdir(path.join(root, 'spaces'), { recursive: true });
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
      const fs = provider.engine.get(handle.providerSandboxId)?.fs;
      if (!fs) throw new Error('no sandbox');
      fs.writeFile('/work/Python-3.15.0.tar.xz', new Uint8Array(9 * 1024 * 1024), {
        parents: true,
      });
      for (let n = 0; n < 2_100; n += 1)
        fs.writeFile(`/work/Python-3.15.0/f${n}.c`, Buffer.from('x'), { parents: true });
      fs.writeFile('/work/report.md', Buffer.from('# Report'), { parents: true });

      // The command's read-back, and its receipt as the ledger keeps it.
      const command = await scope.action(attempt);
      const report = await syncOut({
        provider,
        handle,
        workRoot: path.join(root, 'work'),
        jobId: scope.jobId,
        signal: AbortSignal.timeout(30_000),
      });
      await sql`update action set status = 'succeeded',
          receipt = ${JSON.stringify({ detail: workspaceNote(report), received_at: new Date().toISOString() })}::jsonb
        where id = ${command}`;
      const session = recordId('sbx');
      await sql`insert into sandbox_session (id, connection_id, space_id, job_id, attempt_id, agent_id,
          adapter, provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
        values (${session}, ${scope.connectionId}, ${scope.spaceId}, ${scope.jobId}, ${attempt},
          ${scope.agentId}, 'docker', ${handle.providerSandboxId}, 'melete-sandbox:local',
          '{"kind":"deny_all"}'::jsonb, 'pause', 'ready', now() + interval '1 hour')`;
      await sql`insert into sandbox_command (action_id, session_id, marker)
        values (${command}, ${session}, ${command})`;

      expect(await leftOnComputer(sql, scope.jobId, 'Python-3.15.0/f7.c')).toContain(
        'it is under Python-3.15.0/, which the last read-back from your computer left there (too many files)',
      );
      expect(await leftOnComputer(sql, scope.jobId, 'report.md')).toBeNull();

      const files = createFilesConnector({
        workRoot: path.join(root, 'work'),
        spacesRoot: path.join(root, 'spaces'),
        sql,
        computer: {
          leftThere: (jobId, relative) => leftOnComputer(sql, jobId, relative),
          removeMoved: (input) =>
            removeMovedFromComputers({ ...input, sql, providerFor: () => provider }),
        },
      });
      const move = (from: string, attemptId: string) => {
        const action = {
          ...connectorAction('files.move', { from, to: path.basename(from), to_area: 'artifacts' }),
          job_id: scope.jobId,
          attempt_id: attemptId,
        };
        return files.execute(action, {
          job_id: scope.jobId,
          space_id: scope.spaceId,
          idempotency_key: action.id,
          constraints: jobConstraints.parse({}),
        });
      };

      const refused = await move('Python-3.15.0.tar.xz', attempt);
      if (refused.outcome !== 'failed')
        throw new Error(`expected a refusal, got ${refused.outcome}`);
      expect(refused.reason).toContain(
        'the last read-back from your computer left it there (9 MB, over the 8 MB limit)',
      );
      const moved = await move('report.md', attempt);
      if (moved.outcome !== 'succeeded') throw new Error('expected the move to succeed');
      expect(moved.receipt.detail.computer_copy).toBe('removed');
      expect(fs.list('/work').some((entry) => entry.path === 'report.md')).toBe(false);
      expect(
        await readFile(path.join(root, 'spaces', scope.spaceId, 'artifacts', 'report.md'), 'utf8'),
      ).toBe('# Report');

      // A later step with no computer running: said, not silent.
      const later = await scope.attempt();
      expect(
        await removeMovedFromComputers({
          sql,
          providerFor: () => provider,
          attemptId: later,
          jobId: scope.jobId,
          relative: 'other.md',
          size: 1,
          hash: 'h',
          signal: AbortSignal.timeout(5_000),
        }),
      ).toEqual({ outcome: 'kept', reason: 'your computer is not running in this step' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
