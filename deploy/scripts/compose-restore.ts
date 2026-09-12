/**
 * Destructive restore proof for the explicitly opted-in, disposable Compose stack.
 * Only its verified pgdata volume is replaced. All other volumes and local
 * configuration remain in place, including the independent restriction journal.
 *
 * MELETE_CONFORMANCE_COMPOSE=1 bun deploy/scripts/compose-restore.ts
 *   [--output-dir /private/evidence/root]
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  approveJob,
  compose,
  composeEnv,
  composeFile,
  createApprovalJob,
  docker,
  job,
  repositoryRoot,
  requireCompose,
  serviceId,
  sql,
  waitFor,
  waitForStack,
} from '../../conformance/helpers/compose.ts';

type Container = {
  Id: string;
  Config: { Labels: Record<string, string>; Env: string[] };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string }[];
};
type Volume = { Name: string; CreatedAt: string; Labels: Record<string, string> };
type Phase = { name: string; duration_ms: number; status: 'passed' | 'failed' };
type MemoryProof = {
  phase: string;
  run_id: string;
  space_id: string;
  forgotten_items: number;
  retained_items: number;
  journal_restrictions?: number;
  replayed_restrictions?: number;
};

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const proofScript = 'deploy/scripts/memory-restore-proof.ts';
const projectLabel = 'com.docker.compose.project';
const volumeLabel = 'com.docker.compose.volume';

/** pg_dump is binary: never pass its stdout through the textual Docker helper. */
async function dockerBytes(args: string[], input?: Uint8Array) {
  requireCompose();
  const child = Bun.spawn(['docker', ...args], {
    cwd: repositoryRoot,
    stdin: input ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 180_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
    ]);
    assert.ok(!timedOut, 'The Docker subprocess exceeded 180 seconds.');
    return { code, stdout: new Uint8Array(stdout), stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function inspectVolume(name: string, project: string, logical: string): Promise<Volume> {
  const volumes = JSON.parse(await docker('volume', 'inspect', name)) as Volume[];
  assert.equal(volumes.length, 1);
  const volume = volumes[0];
  assert.ok(volume);
  assert.equal(volume.Name, `${project}_${logical}`);
  assert.equal(volume.Name, name);
  assert.equal(volume.Labels?.[projectLabel], project);
  assert.equal(volume.Labels?.[volumeLabel], logical);
  return { Name: volume.Name, CreatedAt: volume.CreatedAt, Labels: volume.Labels };
}

async function run() {
  requireCompose();
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === '--output-dir' && args[1]),
    'Usage: bun deploy/scripts/compose-restore.ts [--output-dir /private/evidence/root]',
  );
  const runId = `restore-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const evidenceDir = join(resolve(args[1] ?? join(tmpdir(), 'melete-compose-restore')), runId);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const evidencePath = join(evidenceDir, 'evidence.json');
  const backupPath = join(evidenceDir, 'database.dump');
  const evidence: Record<string, unknown> = {
    check: 'compose_restore',
    run_id: runId,
    started_at: new Date().toISOString(),
    phases: [] as Phase[],
    status: 'running',
  };
  const started = performance.now();
  let env: Record<string, string> = {};
  let servicesStopped = false;
  let volumeRemoved = false;
  let databaseRestored = false;
  const redact = (message: string) => {
    let result = message;
    for (const [key, value] of Object.entries(env)) {
      if (value && /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(key))
        result = result.replaceAll(value, '[redacted]');
    }
    return result;
  };
  const save = () =>
    writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  async function phase<T>(name: string, execute: () => Promise<T>): Promise<T> {
    process.stderr.write(`compose restore: ${name}\n`);
    const phaseStarted = performance.now();
    let status: Phase['status'] = 'failed';
    try {
      const result = await execute();
      status = 'passed';
      return result;
    } finally {
      (evidence.phases as Phase[]).push({
        name,
        status,
        duration_ms: Math.round(performance.now() - phaseStarted),
      });
      await save();
    }
  }
  const memoryProof = async (phaseName: 'seed' | 'forget' | 'verify') => {
    const output = await docker(
      'exec',
      await serviceId('melete'),
      'bun',
      proofScript,
      phaseName,
      runId,
    );
    const proof = JSON.parse(output.trim()) as MemoryProof;
    assert.equal(proof.run_id, runId);
    assert.equal(proof.phase, phaseName);
    assert.equal(proof.forgotten_items, phaseName === 'seed' ? 1 : 0);
    assert.equal(proof.retained_items, 1);
    return proof;
  };

  try {
    const preflight = await phase('verify stack and volume ownership', async () => {
      env = await composeEnv();
      assert.equal(env.MELETE_ENABLE_FAKE_PROVIDER, 'true');
      assert.equal(env.MELETE_ENABLE_TEST_CONNECTOR, 'true');
      await waitForStack();
      const ids = (await compose('ps', '-q')).trim().split('\n');
      const containers = JSON.parse(await docker('inspect', ...ids)) as Container[];
      const postgres = containers.find(
        (container) => container.Config.Labels['com.docker.compose.service'] === 'postgres',
      );
      assert.ok(postgres);
      const project = postgres.Config.Labels[projectLabel];
      assert.ok(project && /^[a-z0-9][a-z0-9_-]*$/.test(project));
      assert.ok(containers.every((container) => container.Config.Labels[projectLabel] === project));
      assert.ok(
        containers.every(
          (container) =>
            container.Config.Labels['com.docker.compose.project.config_files'] === composeFile,
        ),
        'The running project was not created from this checkout’s Compose file.',
      );
      const mount = postgres.Mounts.find(
        (candidate) => candidate.Destination === '/var/lib/postgresql/data',
      );
      assert.equal(mount?.Type, 'volume');
      assert.equal(mount?.Name, `${project}_pgdata`);
      const pgdata = await inspectVolume(`${project}_pgdata`, project, 'pgdata');
      const mountedVolumes = new Set(
        containers.flatMap((container) =>
          container.Mounts.flatMap((item) =>
            item.Type === 'volume' && item.Name ? item.Name : [],
          ),
        ),
      );
      const retained: Volume[] = [];
      for (const logical of ['spaces', 'artifacts', 'work', 'runtime-home', 'restrictions']) {
        const name = `${project}_${logical}`;
        assert.ok(mountedVolumes.has(name), `The stack is missing its ${logical} volume.`);
        retained.push(await inspectVolume(name, project, logical));
      }
      assert.equal(mountedVolumes.size, retained.length + 1);
      const pgEnv = Object.fromEntries(
        postgres.Config.Env.map((entry) => {
          const boundary = entry.indexOf('=');
          return [entry.slice(0, boundary), entry.slice(boundary + 1)];
        }),
      );
      assert.ok(pgEnv.POSTGRES_USER && pgEnv.POSTGRES_DB);
      const envHash = sha256(await readFile(join(repositoryRoot, 'deploy/.env')));
      const composeHash = sha256(await readFile(composeFile));
      evidence.project = project;
      evidence.replaced_volume = pgdata;
      evidence.retained_volumes = retained;
      return {
        project,
        pgdata,
        retained,
        user: pgEnv.POSTGRES_USER,
        database: pgEnv.POSTGRES_DB,
        envHash,
        composeHash,
        postgresId: postgres.Id,
      };
    });
    const parked = await phase('park a real job and seed two memory facts', async () => {
      const created = await createApprovalJob({ title: `Restore parked responsibility ${runId}` });
      const database = await sql();
      try {
        await waitFor(
          async () => {
            const [active] = await database`select count(*)::int as count
              from job where state = 'running'`;
            const cells = (
              await docker(
                'ps',
                '-a',
                '-q',
                '--filter',
                'label=com.melete.attempt-supervisor=v1',
                '--filter',
                `label=com.melete.project=${preflight.project}`,
              )
            ).trim();
            return active?.count === 0 && cells === '';
          },
          30_000,
          'running jobs and their supervised cells to settle before taking the snapshot',
        );
        // Superseded epochs can retain open historical rows after restart. They
        // have no live authority; record them without mistaking them for writers.
        const [historical] = await database`select count(*)::int as count
          from attempt a join job j on j.id = a.job_id
          where a.ended_at is null and a.epoch < j.lease_epoch`;
        evidence.superseded_unended_attempt_rows = historical?.count ?? 0;
        const approvals = await database`select a.id, a.payload_hash, p.id as approval_id
          from action a join approval p on p.action_id = a.id
          where a.job_id = ${created.jobId} and a.status = 'needs_approval'`;
        assert.equal(approvals.length, 1);
        evidence.job_id = created.jobId;
        evidence.parked_approval = approvals[0];
      } finally {
        await database.end();
      }
      evidence.memory_seed = await memoryProof('seed');
      return created;
    });
    await phase('stop Melete and snapshot Postgres', async () => {
      servicesStopped = true;
      await compose('stop', 'melete');
      const dump = await dockerBytes([
        'exec',
        await serviceId('postgres'),
        'pg_dump',
        '-U',
        preflight.user,
        '-d',
        preflight.database,
        '-Fc',
      ]);
      assert.equal(dump.code, 0, redact(dump.stderr));
      assert.equal(new TextDecoder().decode(dump.stdout.subarray(0, 5)), 'PGDMP');
      await writeFile(backupPath, dump.stdout, { flag: 'wx', mode: 0o600 });
      evidence.snapshot = { bytes: dump.stdout.byteLength, sha256: sha256(dump.stdout) };
    });
    await phase('forget the clinic after the snapshot', async () => {
      await compose('start', 'melete');
      await waitForStack();
      servicesStopped = false;
      evidence.memory_after_forget = await memoryProof('forget');
      assert.equal((await job(parked.jobId)).state, 'waiting_for_approval');
    });
    await phase('replace only the verified Postgres volume', async () => {
      // Verify the saved bytes and the selected project again before destruction.
      assert.equal(
        sha256(await readFile(backupPath)),
        (evidence.snapshot as { sha256: string }).sha256,
      );
      assert.equal(sha256(await readFile(composeFile)), preflight.composeHash);
      assert.equal(sha256(await readFile(join(repositoryRoot, 'deploy/.env'))), preflight.envHash);
      assert.equal(await serviceId('postgres'), preflight.postgresId);
      // No --volumes, --remove-orphans, broad volume filters, or host prune.
      servicesStopped = true;
      await compose('down');
      for (const volume of preflight.retained)
        assert.deepEqual(
          await inspectVolume(volume.Name, preflight.project, volume.Labels[volumeLabel] ?? ''),
          volume,
        );
      assert.deepEqual(
        await inspectVolume(preflight.pgdata.Name, preflight.project, 'pgdata'),
        preflight.pgdata,
      );
      const consumers = (
        await docker('ps', '-a', '-q', '--filter', `volume=${preflight.pgdata.Name}`)
      ).trim();
      assert.equal(consumers, '', 'The exact pgdata volume is still attached to a container.');
      await docker('volume', 'rm', preflight.pgdata.Name);
      volumeRemoved = true;
      await compose('up', '-d', '--wait', 'postgres');
      await inspectVolume(preflight.pgdata.Name, preflight.project, 'pgdata');
    });
    await phase('restore into the empty database', async () => {
      const backup = await readFile(backupPath);
      assert.equal(sha256(backup), (evidence.snapshot as { sha256: string }).sha256);
      const restored = await dockerBytes(
        [
          'exec',
          '-i',
          await serviceId('postgres'),
          'pg_restore',
          '-U',
          preflight.user,
          '-d',
          preflight.database,
          '--no-owner',
          '--no-privileges',
          '--exit-on-error',
        ],
        backup,
      );
      assert.equal(restored.code, 0, redact(restored.stderr));
      databaseRestored = true;
    });
    await phase('prove the old snapshot fails before journal replay', async () => {
      // Override the image CMD. This helper reads; it cannot perform startup recovery.
      const result = await dockerBytes([
        'compose',
        '-f',
        composeFile,
        'run',
        '--no-deps',
        '--rm',
        'melete',
        'bun',
        proofScript,
        'verify',
        runId,
      ]);
      const expected = 'The retained restriction has not been replayed into this database.';
      assert.notEqual(result.code, 0, 'The old snapshot unexpectedly passed before startup.');
      assert.ok(result.stderr.includes(expected), redact(result.stderr));
      evidence.before_replay = { exit_code: result.code, expected_failure: expected };
    });
    await phase('start normally and verify replay and retained volumes', async () => {
      await compose('up', '-d', '--wait');
      await waitForStack();
      servicesStopped = false;
      const proof = await memoryProof('verify');
      assert.ok(proof.journal_restrictions && proof.journal_restrictions > 0);
      assert.equal(proof.replayed_restrictions, proof.journal_restrictions);
      evidence.memory_after_restore = proof;
      for (const volume of preflight.retained)
        assert.deepEqual(
          await inspectVolume(volume.Name, preflight.project, volume.Labels[volumeLabel] ?? ''),
          volume,
        );
      assert.equal(
        sha256(await readFile(join(repositoryRoot, 'deploy/.env'))),
        preflight.envHash,
        'The local environment file changed during restore.',
      );
      evidence.non_database_volumes_preserved = true;
      evidence.environment_preserved = true;
    });
    await phase('approve the restored job once and verify its receipt', async () => {
      assert.equal((await job(parked.jobId)).state, 'waiting_for_approval');
      const database = await sql();
      try {
        const approvals = await database`select a.id, a.payload_hash, p.id as approval_id
          from action a join approval p on p.action_id = a.id where a.job_id = ${parked.jobId}`;
        assert.equal(approvals.length, 1);
        assert.deepEqual(approvals[0], evidence.parked_approval);
        const before = await database`select d.action_id from test_destination_ledger d
          join action a on a.id = d.action_id where a.job_id = ${parked.jobId}`;
        assert.equal(before.length, 0);
        await approveJob(parked.jobId);
        const actions =
          await database`select id, status, receipt from action where job_id = ${parked.jobId}`;
        const delivered = await database`select d.action_id from test_destination_ledger d
          join action a on a.id = d.action_id where a.job_id = ${parked.jobId}`;
        assert.equal(actions.length, 1);
        assert.equal(actions[0]?.status, 'succeeded');
        assert.ok(actions[0]?.receipt);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]?.action_id, actions[0]?.id);
        evidence.final_job_state = (await job(parked.jobId)).state;
        evidence.actions = actions;
        evidence.destination_effects = delivered.length;
      } finally {
        await database.end();
      }
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = redact(error instanceof Error ? error.message : String(error));
    if (servicesStopped) {
      try {
        if (!volumeRemoved || databaseRestored) {
          await compose('up', '-d', '--wait');
          await waitForStack();
          evidence.recovery = 'The stack is healthy; the original proof failure is retained.';
        } else {
          // Do not start migration/workers against a failed or partial restore.
          await compose('up', '-d', '--wait', 'postgres');
          evidence.recovery =
            'Postgres is healthy. Restore was incomplete; Melete remains stopped.';
        }
      } catch (recoveryError) {
        evidence.recovery_error = redact(
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        );
      }
    }
    process.exitCode = 1;
  } finally {
    evidence.total_ms = Math.round(performance.now() - started);
    await save();
    process.stdout.write(
      `${JSON.stringify({ status: evidence.status, evidence: evidencePath, backup: backupPath })}\n`,
    );
    if (evidence.error) process.stderr.write(`${evidence.error}\n`);
  }
}

if (import.meta.main) await run();
