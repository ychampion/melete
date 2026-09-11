/** Real HTTP submission, claimed Hermes cells and durable approval across restart. */
import assert from 'node:assert/strict';
import {
  approveJob,
  compose,
  createStackJob,
  docker,
  job,
  requireCompose,
  sql,
  waitFor,
  waitForJob,
  waitForStack,
} from '../../conformance/helpers/compose.ts';

requireCompose();
await waitForStack();
const started = performance.now();
const { jobId } = await createStackJob({ title: 'Restart a running responsibility' });
const database = await sql();
try {
  const child = await waitFor(
    async () => {
      const id = (
        await docker(
          'ps',
          '-q',
          '--no-trunc',
          '--filter',
          'label=com.melete.attempt-supervisor=v1',
          '--filter',
          `label=com.melete.job=${jobId}`,
        )
      ).trim();
      return id || false;
    },
    30_000,
    'the live job cell',
  );
  // A deterministic crash window: the cell exists, its job is claimed, and
  // its engine cannot finish while Compose restarts the service and peers.
  await docker('kill', '--signal', 'STOP', child);
  assert.equal((await job(jobId)).state, 'running');
  const initial = await database`select id, epoch from attempt where job_id = ${jobId}`;
  assert.equal(initial.length, 1);
  const restartStarted = performance.now();
  await compose('restart');
  await waitForStack();
  const activeRestartMs = Math.round(performance.now() - restartStarted);
  await waitForJob(jobId, 'waiting_for_approval');
  const afterRestart = await database`select id, epoch, outcome, lease_status from attempt
    where job_id = ${jobId} order by epoch`;
  assert.ok(afterRestart.length >= 2);
  assert.ok(afterRestart.every((attempt) => attempt.id !== undefined));
  assert.notEqual(afterRestart.at(-1)?.id, initial[0]?.id);
  const [approval] = await database`select a.id, a.payload_hash, p.id as approval_id
    from action a join approval p on p.action_id = a.id
    where a.job_id = ${jobId} and a.status = 'needs_approval'`;
  assert.ok(approval);
  assert.equal(
    (
      await database`select d.action_id from test_destination_ledger d
    join action a on a.id = d.action_id where a.job_id = ${jobId}`
    ).length,
    0,
  );
  const parkedStarted = performance.now();
  await compose('restart');
  await waitForStack();
  const parkedRestartMs = Math.round(performance.now() - parkedStarted);
  assert.equal((await job(jobId)).state, 'waiting_for_approval');
  const [retained] = await database`select a.id, a.payload_hash, p.id as approval_id
    from action a join approval p on p.action_id = a.id where a.job_id = ${jobId}`;
  assert.deepEqual(retained, approval);
  await approveJob(jobId);
  const actions = await database`select id, status, receipt from action where job_id = ${jobId}`;
  const delivered = await database`select d.action_id from test_destination_ledger d
    join action a on a.id = d.action_id where a.job_id = ${jobId}`;
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.status, 'succeeded');
  assert.ok(actions[0]?.receipt);
  assert.equal(delivered.length, 1);
  const attempts = await database`select id, epoch, outcome, lease_status from attempt
    where job_id = ${jobId} order by epoch`;
  assert.equal(new Set(attempts.map((attempt) => attempt.id)).size, attempts.length);
  const events =
    await database`select type, payload from event where job_id = ${jobId} order by seq`;
  assert.ok(events.some((event) => event.type === 'attempt_started'));
  assert.ok(events.some((event) => event.type === 'attempt_ended'));
  console.log(
    JSON.stringify(
      {
        check: 'compose_vertical',
        job_id: jobId,
        active_restart_ms: activeRestartMs,
        parked_restart_ms: parkedRestartMs,
        total_ms: Math.round(performance.now() - started),
        actions: actions.length,
        destination_effects: delivered.length,
        attempts,
        event_count: events.length,
      },
      null,
      2,
    ),
  );
} finally {
  await database.end();
}
