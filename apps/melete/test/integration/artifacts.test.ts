/**
 * Artifacts end to end against a real database: a declared write becomes a
 * record with its checks beside it, a failing check keeps the job from
 * completing, fixing the file lets it complete, and publishing is an approved
 * external effect with a receipt that links back to the record.
 *
 * The falsifier this file exists for: a CSV whose totals do not add up cannot
 * complete the job, and the same job completes once the numbers are right.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonValue } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { artifactGate } from '../../src/artifact/gate.ts';
import { acceptArtifact, createArtifactRecorder } from '../../src/artifact/record.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createArtifactsConnector } from '../../src/connectors/artifacts.ts';
import { createExecConnector } from '../../src/connectors/exec.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { artifact as artifactTable, job as jobTable } from '../../src/db/schema.ts';
import { completionFacts } from '../../src/jobs/bundle.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

// The shared server, not a second embedded cluster: every integration suite
// that starts its own costs the same box another postgres.
const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;

// Dropping a database takes longer than the default hook budget on this box.
afterAll(async () => {
  await fixture?.close();
}, 15_000);

const SCOPES = [
  'files.write',
  'files.read',
  'files.list',
  'files.move',
  'exec.run',
  'exec.python',
  'artifact.publish',
];

const sent: Array<{ to: string[]; subject: string; attachments: { filename: string }[] }> = [];

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const seed = await seedJob(sql, { scopes: SCOPES, provider: 'files' });
  const roots = await mkdtemp(path.join(tmpdir(), 'melete-artifacts-'));
  const workRoot = path.join(roots, 'work');
  const spacesRoot = path.join(roots, 'spaces');
  await Bun.write(path.join(workRoot, seed.claims.job_id, '.keep'), '');
  await Bun.write(path.join(spacesRoot, seed.claims.space_id, 'artifacts', '.keep'), '');
  const execConnection = recordId('conn');
  const publishConnection = recordId('conn');
  for (const [id, provider] of [
    [execConnection, 'exec'],
    [publishConnection, 'artifacts'],
  ] as const) {
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${id}, ${seed.claims.space_id}, ${provider}, 'Fixture', ${JSON.stringify(SCOPES)}::jsonb)`;
  }
  const registry = new ConnectorRegistry()
    .register(seed.connectionId, createFilesConnector({ workRoot, spacesRoot }))
    .register(execConnection, createExecConnector({ workRoot }))
    .register(
      publishConnection,
      createArtifactsConnector({
        sql,
        workRoot,
        spacesRoot,
        mailer: {
          async send(message) {
            sent.push({
              to: message.to,
              subject: message.subject,
              attachments: message.attachments.map((a) => ({ filename: a.filename })),
            });
            return { messageId: message.messageId, accepted: message.to, rejected: [] };
          },
        },
      }),
    );
  const broker = new BrokerService({
    sql,
    connectors: registry,
    recordArtifact: createArtifactRecorder(),
  });
  return { ...seed, broker, execConnection, publishConnection, workRoot, spacesRoot, sql };
}

const csv = (chairAmount: string) =>
  `item,amount\nDesk,60.00\nChair,${chairAmount}\nTotal,100.00\n`;

const totalsExpectation: JsonValue = {
  kind: 'csv',
  checks: [
    { kind: 'totals', column: 'amount', total_label: 'Total' },
    { kind: 'required_columns', columns: ['item', 'amount'] },
  ],
};

databaseTest('a CSV whose totals do not add up cannot complete the job', async () => {
  const context = await setup();
  const wrong = await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: { path: 'report.csv', content: csv('31.50'), expect: totalsExpectation },
    client_ref: 'write-1',
  });
  // The write itself succeeded: the bytes are on disk and the receipt says so.
  expect(wrong.status).toBe('succeeded');

  const rows = await context.sql`select id, kind, area, path, source_job_id, expectation
    from artifact where job_id = ${context.claims.job_id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind).toBe('csv');
  expect(rows[0]?.area).toBe('work');
  expect(rows[0]?.source_job_id).toBe(context.claims.job_id);

  const failing = await artifactGate(fixture?.db as never, context.claims.job_id);
  expect(failing.passed).toBe(false);
  expect(failing.failures.join(' ')).toContain('totals:amount');
  expect(failing.failures.join(' ')).toContain('91.5');

  // The job asks to complete, and the state machine sends it to the owner with
  // the arithmetic named rather than recording a deliverable that is wrong.
  const before = await facts(context.claims.job_id);
  expect(before.artifact_validations_passed).toBe(false);
  expect(before.artifact_failures.join(' ')).toContain('totals:amount');

  // Fixing the file is another write, which is another artifact row.
  const right = await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: { path: 'report.csv', content: csv('40.00'), expect: totalsExpectation },
    client_ref: 'write-2',
  });
  expect(right.status).toBe('succeeded');
  const after = await facts(context.claims.job_id);
  expect(after.artifact_validations_passed).toBe(true);
  expect(after.artifact_failures).toEqual([]);
  const both = await context.sql`select id from artifact where job_id = ${context.claims.job_id}`;
  expect(both).toHaveLength(2);
});

async function facts(jobId: string) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: jobTable.id, spaceId: jobTable.spaceId, constraints: jobTable.constraints })
      .from(jobTable)
      .where(eq(jobTable.id, jobId));
    if (!row) throw new Error('no job row');
    return completionFacts(tx, row as never, {
      kind: 'completed',
      summary: 'done',
      evidence: [],
    });
  });
}

databaseTest('a declared human acceptance blocks until the owner gives it', async () => {
  const context = await setup();
  await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: {
      path: 'summary.md',
      content: '# Findings\n\nAll clear.\n',
      expect: { kind: 'markdown', human: true },
    },
    client_ref: 'write-human',
  });
  const waiting = await artifactGate(fixture?.db as never, context.claims.job_id);
  expect(waiting.passed).toBe(false);
  expect(waiting.failures.join(' ')).toContain('human is still waiting');

  const [row] = await context.sql`select id from artifact where job_id = ${context.claims.job_id}`;
  const accepted = await acceptArtifact(context.sql, {
    artifact_id: String(row?.id),
    decision: 'accepted',
  });
  expect(accepted.status).toBe('passed');
  const done = await artifactGate(fixture?.db as never, context.claims.job_id);
  expect(done.passed).toBe(true);
});

databaseTest('a critique with no configured critic is recorded as unavailable', async () => {
  const context = await setup();
  await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: {
      path: 'note.md',
      content: '# Note\n\nbody\n',
      expect: { kind: 'markdown', critique: 'is this clear?' },
    },
    client_ref: 'write-critique',
  });
  const [critique] = await context.sql`select status, advisory from artifact_validation v
    join artifact a on a.id = v.artifact_id
    where a.job_id = ${context.claims.job_id} and v.name = 'critique'`;
  expect(critique?.status).toBe('unavailable');
  expect(critique?.advisory).toBe(true);
  // Advisory results never block, whatever they say.
  expect((await artifactGate(fixture?.db as never, context.claims.job_id)).passed).toBe(true);
});

databaseTest('an execution is on the ledger without anyone being asked', async () => {
  const context = await setup();
  const digest = new Bun.CryptoHasher('sha256').update('wrote out.csv\n').digest('hex');
  const proposal = await context.broker.propose(context.claims, {
    kind: 'exec.python',
    connection_id: context.execConnection,
    payload: {
      language: 'python',
      command: "open('out.csv','w').write('a,b\\n')",
      cwd: '.',
      exit_code: 0,
      signal: null,
      timed_out: false,
      duration_ms: 41,
      output_digest: digest,
      output_bytes: 14,
      truncated: false,
      output_path: null,
    },
    client_ref: 'exec-1',
  });
  expect(proposal.status).toBe('succeeded');
  expect(proposal.requires_approval).toBe(false);
  expect(proposal.effect_class).toBe('write_reversible');
  const [action] = await context.sql`select kind, status, effect_class, receipt
    from action where job_id = ${context.claims.job_id} and kind = 'exec.python'`;
  expect(action?.status).toBe('succeeded');
  expect(action?.receipt?.detail).toMatchObject({ exit_code: 0, duration_ms: 41, cwd: '.' });
});

databaseTest('an execution claiming another job workspace is refused at the ledger', async () => {
  const context = await setup();
  const proposal = await context.broker.propose(context.claims, {
    kind: 'exec.run',
    connection_id: context.execConnection,
    payload: {
      language: 'shell',
      command: 'ls',
      cwd: '../job_01J00000000000000000000000',
      exit_code: 0,
      signal: null,
      timed_out: false,
      duration_ms: 5,
      output_digest: 'b'.repeat(64),
      output_bytes: 0,
      truncated: false,
      output_path: null,
    },
    client_ref: 'exec-escape',
  });
  expect(proposal.status).toBe('failed');
  const [action] = await context.sql`select status, reconciliation from action
    where job_id = ${context.claims.job_id} and kind = 'exec.run'`;
  expect(action?.status).toBe('failed');
  expect(String(action?.reconciliation?.reason)).toContain('outside this job workspace');
});

databaseTest('publishing is approved once and leaves a receipt linked to the record', async () => {
  const context = await setup();
  await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: { path: 'report.csv', content: csv('40.00'), expect: totalsExpectation },
    client_ref: 'write-publish',
  });
  const request = {
    kind: 'artifact.publish',
    connection_id: context.publishConnection,
    payload: {
      path: 'report.csv',
      destination: { kind: 'space_artifacts', path: 'report.csv' },
    },
    client_ref: 'publish-1',
  };
  const parked = await context.broker.propose(context.claims, request);
  expect(parked.status).toBe('needs_approval');
  expect(parked.effect_class).toBe('write_external');

  await context.broker.decide(parked.action_id, {
    decision: 'approved',
    payload_hash: parked.payload_hash,
  });
  const published = await context.broker.propose(context.claims, request);
  expect(published.status).toBe('succeeded');
  expect(published.action_id).toBe(parked.action_id);

  const copied = await readFile(
    path.join(context.spacesRoot, context.claims.space_id, 'artifacts', 'report.csv'),
    'utf8',
  );
  // The broker canonicalises a payload before it is hashed, and canonicalising
  // trims strings, so what reaches disk is the trimmed content. The approval
  // was given over those exact bytes, and those are the bytes that travelled.
  expect(copied).toBe(csv('40.00').trim());

  const [publication] = await context.sql`select p.destination, p.external_ref, p.action_id
    from artifact_publication p join artifact a on a.id = p.artifact_id
    where a.job_id = ${context.claims.job_id}`;
  expect(publication?.destination).toBe('space_artifacts');
  expect(publication?.action_id).toBe(parked.action_id);
  expect(publication?.external_ref).toBe('report.csv');
});

databaseTest('a file that changed since it was recorded is not published', async () => {
  const context = await setup();
  await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: { path: 'report.csv', content: csv('40.00'), expect: totalsExpectation },
    client_ref: 'write-drift',
  });
  // Someone rewrote the bytes without declaring anything: the record and the
  // file no longer agree, and an approval given over the record is void.
  await Bun.write(path.join(context.workRoot, context.claims.job_id, 'report.csv'), csv('999.00'));
  const request = {
    kind: 'artifact.publish',
    connection_id: context.publishConnection,
    payload: { path: 'report.csv', destination: { kind: 'space_artifacts', path: null } },
    client_ref: 'publish-drift',
  };
  const parked = await context.broker.propose(context.claims, request);
  await context.broker.decide(parked.action_id, {
    decision: 'approved',
    payload_hash: parked.payload_hash,
  });
  const attempted = await context.broker.propose(context.claims, request);
  expect(attempted.status).toBe('unknown');
  const [action] = await context.sql`select status from action where id = ${parked.action_id}`;
  expect(action?.status).toBe('unknown');
});

databaseTest('a publish by email attaches the recorded bytes, not payload bytes', async () => {
  const context = await setup();
  sent.length = 0;
  await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: { path: 'report.csv', content: csv('40.00'), expect: totalsExpectation },
    client_ref: 'write-mail',
  });
  const request = {
    kind: 'artifact.publish',
    connection_id: context.publishConnection,
    payload: {
      path: 'report.csv',
      destination: {
        kind: 'email',
        to: 'owner@example.com',
        subject: 'The numbers',
        body: 'Attached.',
        filename: null,
      },
    },
    client_ref: 'publish-mail',
  };
  const parked = await context.broker.propose(context.claims, request);
  expect(parked.status).toBe('needs_approval');
  await context.broker.decide(parked.action_id, {
    decision: 'approved',
    payload_hash: parked.payload_hash,
  });
  const done = await context.broker.propose(context.claims, request);
  expect(done.status).toBe('succeeded');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.attachments[0]?.filename).toBe('report.csv');
  expect(sent[0]?.to).toEqual(['owner@example.com']);
});

databaseTest('a file with no artifact record cannot be published at all', async () => {
  const context = await setup();
  await context.broker.propose(context.claims, {
    kind: 'files.write',
    connection_id: context.connectionId,
    payload: { path: 'scratch.txt', content: 'notes' },
    client_ref: 'write-scratch',
  });
  const none = await context.sql`select id from artifact where job_id = ${context.claims.job_id}`;
  expect(none).toHaveLength(0);
  const request = {
    kind: 'artifact.publish',
    connection_id: context.publishConnection,
    payload: { path: 'scratch.txt', destination: { kind: 'space_artifacts', path: null } },
    client_ref: 'publish-scratch',
  };
  const parked = await context.broker.propose(context.claims, request);
  await context.broker.decide(parked.action_id, {
    decision: 'approved',
    payload_hash: parked.payload_hash,
  });
  const attempted = await context.broker.propose(context.claims, request);
  expect(attempted.status).toBe('unknown');
  const stored = await fixture?.db
    .select()
    .from(artifactTable)
    .where(eq(artifactTable.jobId, context.claims.job_id));
  expect(stored).toHaveLength(0);
});
