/**
 * Artifacts end to end against a real database: a declared write becomes a
 * record with its checks beside it, a failing check keeps the job from
 * completing, fixing the file lets it complete, and publishing is an approved
 * external effect with a receipt that links back to the record.
 *
 * The falsifier this file exists for: a CSV whose totals do not add up cannot
 * complete the job, and the same job completes once the numbers are right.
 */
import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonValue } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { artifactGate } from '../../src/artifact/gate.ts';
import {
  acceptArtifact,
  createArtifactRecorder,
  recordArtifactFromReceipt,
} from '../../src/artifact/record.ts';
import { recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createArtifactsConnector } from '../../src/connectors/artifacts.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { createExecConnector } from '../../src/connectors/exec.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ImapSmtpTransport } from '../../src/connectors/mail-transport.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from '../../src/connectors/secrets.ts';
import { artifact as artifactTable, job as jobTable } from '../../src/db/schema.ts';
import { completionFacts } from '../../src/jobs/bundle.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { resolvePython } from '../../src/runtime/python.ts';
import { testDatabase } from '../helpers/database.ts';

// The shared server, not a second embedded cluster: every integration suite
// that starts its own costs the same box another postgres.
const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;

// Each of these walks the broker end to end against a real database, which is
// slower than the five seconds a test gets by default, and slower again on a
// machine running other suites at the same time. A test that times out reports
// itself as a failure of the property it was checking, which is a lie.
const SLOW = 30_000;

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
  const mailConnection = recordId('conn');
  await sql`insert into connection (id, space_id, provider, label, scopes) values (${mailConnection}, ${seed.claims.space_id}, 'imap', 'Fixture mailbox', '["email.send"]'::jsonb)`;
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
          connectionId: mailConnection,
          spaceId: seed.claims.space_id,
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
    recordArtifact: createArtifactRecorder(undefined, { workRoot, spacesRoot }),
  });
  return {
    ...seed,
    broker,
    execConnection,
    publishConnection,
    mailConnection,
    workRoot,
    spacesRoot,
    sql,
  };
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

databaseTest(
  'non-advisory unavailable renderer permits completion',
  async () => {
    const ctx = await setup();
    await ctx.broker.propose(ctx.claims, {
      kind: 'files.write',
      connection_id: ctx.connectionId,
      payload: {
        path: 'report.pdf',
        content: '%PDF-1.7\nfixture',
        expect: { kind: 'pdf', render: true },
      },
    });
    const factsBefore = await facts(ctx.claims.job_id, ctx);
    expect(factsBefore.artifact_validations_passed).toBe(false);
    expect(factsBefore.artifact_failures.join(' ')).toContain('render:pdf could not run');
    const [renderer] =
      await ctx.sql`select status, advisory from artifact_validation where artifact_id in (select id from artifact where job_id = ${ctx.claims.job_id}) and name = 'render:pdf'`;
    expect(renderer).toMatchObject({ status: 'unavailable', advisory: false });
    // An explicitly advisory result remains non-blocking.
    await ctx.sql`update artifact_validation set advisory = true where artifact_id in (select id from artifact where job_id = ${ctx.claims.job_id})`;
    expect((await facts(ctx.claims.job_id, ctx)).artifact_validations_passed).toBe(true);
  },
  SLOW,
);

databaseTest(
  'duplicate persisted validation names cannot overwrite a failure',
  async () => {
    const ctx = await setup();
    const duplicate = (status: string) => ({
      name: 'row_count',
      class: 'deterministic',
      status,
      detail: '',
      evidence: {},
      advisory: false,
      checked_at: new Date().toISOString(),
    });
    let refusal: unknown;
    try {
      await ctx.sql.begin(async (tx) =>
        recordArtifactFromReceipt(tx, {
          job: { id: ctx.claims.job_id, space_id: ctx.claims.space_id },
          action: { id: recordId('act'), kind: 'files.write' },
          receipt: {
            action_id: recordId('act'),
            detail: {
              artifact: {
                area: 'work',
                path: 'duplicate.csv',
                kind: 'csv',
                mime: 'text/csv',
                size: 8,
                content_hash: 'a'.repeat(64),
                template: null,
                evidence: [],
              },
              expectation: { kind: 'csv', checks: [{ kind: 'row_count', min: 10 }], render: false },
              validations: [duplicate('failed'), duplicate('passed')],
            },
          },
        }),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'payload_invalid' });
    expect(await ctx.sql`select id from artifact where job_id = ${ctx.claims.job_id}`).toHaveLength(
      0,
    );
  },
  SLOW,
);

databaseTest(
  'row_count min10 followed by min1 silently removes failure',
  async () => {
    const ctx = await setup();
    await ctx.broker.propose(ctx.claims, {
      kind: 'files.write',
      connection_id: ctx.connectionId,
      payload: {
        path: 'duplicate.csv',
        content: 'item\none',
        expect: { kind: 'csv', checks: [{ kind: 'row_count', min: 10 }] },
      },
    });
    const [original] = await ctx.sql`select id from artifact where job_id = ${ctx.claims.job_id}`;
    const request = {
      kind: 'files.write',
      connection_id: ctx.connectionId,
      payload: {
        path: 'duplicate.csv',
        content: 'item\none',
        expect: {
          kind: 'csv',
          checks: [
            { kind: 'row_count', min: 10 },
            { kind: 'row_count', min: 1 },
          ],
        },
      },
    };
    let refusal: unknown;
    try {
      await ctx.broker.propose(ctx.claims, request);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'payload_invalid' });
    expect(String(refusal)).toContain('row_count');
    const [row] =
      await ctx.sql`select status from artifact_validation where artifact_id = ${original?.id} and name = 'row_count'`;
    expect(row?.status).toBe('failed');
    expect((await artifactGate(fixture?.db as never, ctx.claims.job_id, ctx)).passed).toBe(false);
    const actions = await ctx.sql`select id from action where job_id = ${ctx.claims.job_id}`;
    expect(actions).toHaveLength(1);
  },
  SLOW,
);

databaseTest(
  'validation digest must match the current artifact digest',
  async () => {
    const ctx = await setup();
    await ctx.broker.propose(ctx.claims, {
      kind: 'files.write',
      connection_id: ctx.connectionId,
      payload: { path: 'digest.csv', content: csv('40.00'), expect: totalsExpectation },
    });
    const [row] =
      await ctx.sql`select a.content_hash, v.validated_content_hash from artifact a join artifact_validation v on v.artifact_id = a.id where a.job_id = ${ctx.claims.job_id} limit 1`;
    expect(row?.validated_content_hash).toBe(row?.content_hash);
    await ctx.sql`update artifact_validation set validated_content_hash = ${'0'.repeat(64)} where artifact_id in (select id from artifact where job_id = ${ctx.claims.job_id})`;
    expect((await facts(ctx.claims.job_id, ctx)).artifact_validations_passed).toBe(false);
  },
  SLOW,
);

for (const mode of ['write', 'execution', 'raw']) {
  databaseTest(
    mode === 'write'
      ? 'incorrect CSV overwrite retains passing totals validation'
      : `${mode} mutation invalidates historical totals validation`,
    async () => {
      const ctx = await setup();
      await ctx.broker.propose(ctx.claims, {
        kind: 'files.write',
        connection_id: ctx.connectionId,
        payload: { path: 'mutation.csv', content: csv('40.00'), expect: totalsExpectation },
      });
      const [original] =
        await ctx.sql`select id, content_hash from artifact where job_id = ${ctx.claims.job_id}`;
      if (mode === 'write') {
        await ctx.broker.propose(ctx.claims, {
          kind: 'files.write',
          connection_id: ctx.connectionId,
          payload: { path: 'mutation.csv', content: csv('31.50') },
        });
      } else if (mode === 'raw') {
        await Bun.write(path.join(ctx.workRoot, ctx.claims.job_id, 'mutation.csv'), csv('31.50'));
      } else {
        const code = `open('mutation.csv', 'w').write(${JSON.stringify(csv('31.50'))})`;
        const proposal = await ctx.broker.propose(ctx.claims, {
          kind: 'exec.python',
          connection_id: ctx.execConnection,
          payload: { intent: { code } },
        });
        expect((await ctx.broker.startExecution(ctx.claims, proposal.action_id)).execute).toBe(
          true,
        );
        const child = Bun.spawn([resolvePython(), '-c', code], {
          cwd: path.join(ctx.workRoot, ctx.claims.job_id),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(await child.exited).toBe(0);
        await ctx.broker.settleExecution(ctx.claims, proposal.action_id, {
          record: {
            language: 'python',
            command: code,
            cwd: '.',
            exit_code: 0,
            signal: null,
            timed_out: false,
            duration_ms: 10,
            output_digest: new Bun.CryptoHasher('sha256').update('').digest('hex'),
            output_bytes: 0,
            output_path: null,
            truncated: false,
          },
        });
      }
      const gate = await artifactGate(fixture?.db as never, ctx.claims.job_id, ctx);
      expect(gate.passed).toBe(false);
      if (mode !== 'raw') expect(gate.failures.join(' ')).toContain('91.5');
      const [history] =
        await ctx.sql`select status from artifact_validation where artifact_id = ${original?.id} and name = 'totals:amount'`;
      expect(history?.status).toBe('passed');
    },
    SLOW,
  );
}

databaseTest(
  'an approval for version A publishes recorded version B',
  async () => {
    const ctx = await setup();
    const write = (content: string) =>
      ctx.broker.propose(ctx.claims, {
        kind: 'files.write',
        connection_id: ctx.connectionId,
        payload: { path: 'approved.txt', content, expect: { kind: 'text', render: false } },
      });
    await write('version A');
    const proposal = await ctx.broker.propose(ctx.claims, {
      kind: 'artifact.publish',
      connection_id: ctx.publishConnection,
      payload: { path: 'approved.txt', destination: { kind: 'space_artifacts' } },
    });
    await ctx.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await ctx.broker.admit(ctx.claims, proposal.action_id, proposal.payload_hash);
    await write('version B');
    const dispatched = await ctx.broker.dispatch(proposal.action_id);
    expect(dispatched.status).toBe('failed');
    expect(
      await Bun.file(
        path.join(ctx.spacesRoot, ctx.claims.space_id, 'artifacts', 'approved.txt'),
      ).exists(),
    ).toBe(false);
    const [versionA] =
      await ctx.sql`select id, content_hash from artifact where job_id = ${ctx.claims.job_id} and path = 'approved.txt' order by created_at, id limit 1`;
    expect(proposal.canonical_payload).toMatchObject({
      artifact_id: versionA?.id,
      content_hash: versionA?.content_hash,
    });
    const fresh = await ctx.broker.propose(ctx.claims, {
      kind: 'artifact.publish',
      connection_id: ctx.publishConnection,
      payload: { path: 'approved.txt', destination: { kind: 'space_artifacts' } },
    });
    expect(fresh.status).toBe('needs_approval');
    expect(fresh.payload_hash).not.toBe(proposal.payload_hash);
  },
  SLOW,
);

for (const phase of ['admission', 'dispatch']) {
  databaseTest(
    `cross_space_mailbox: mailbox generation is checked at ${phase}`,
    async () => {
      const ctx = await setup();
      await ctx.broker.propose(ctx.claims, {
        kind: 'files.write',
        connection_id: ctx.connectionId,
        payload: {
          path: 'generation.txt',
          content: 'checked',
          expect: { kind: 'text', render: false },
        },
      });
      const proposal = await ctx.broker.propose(ctx.claims, {
        kind: 'artifact.publish',
        connection_id: ctx.publishConnection,
        payload: {
          path: 'generation.txt',
          destination: { kind: 'email', to: 'owner@example.test', subject: 'generation' },
        },
      });
      expect(proposal.canonical_payload).toMatchObject({
        mailbox_connection_id: ctx.mailConnection,
        mailbox_generation: 0,
      });
      await ctx.broker.decide(proposal.action_id, {
        decision: 'approved',
        payload_hash: proposal.payload_hash,
      });
      if (phase === 'dispatch')
        await ctx.broker.admit(ctx.claims, proposal.action_id, proposal.payload_hash);
      await ctx.sql`update connection set generation = generation + 1 where id = ${ctx.mailConnection}`;
      const before = sent.length;
      if (phase === 'admission') {
        let refusal: unknown;
        try {
          await ctx.broker.admit(ctx.claims, proposal.action_id, proposal.payload_hash);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toMatchObject({ code: 'scope_denied' });
      } else expect((await ctx.broker.dispatch(proposal.action_id)).status).toBe('failed');
      expect(sent.length).toBe(before);
    },
    SLOW,
  );
}

databaseTest(
  'cross_space_mailbox',
  async () => {
    const context = await setup();
    await context.broker.propose(context.claims, {
      kind: 'files.write',
      connection_id: context.connectionId,
      payload: { path: 'mail.txt', content: 'space B', expect: { kind: 'text', render: false } },
    });
    const a = await seedJob(context.sql, { scopes: ['email.send'], provider: 'imap' });
    const masterKey = 'ab'.repeat(32);
    const secrets = new SealedSecretStore(
      new PostgresSecretRepository(context.sql),
      () => masterKey,
    );
    const secret = await secrets.put(a.claims.space_id, 'fake-password');
    await context.sql`update connection set secret_ref = ${secret} where id = ${a.connectionId}`;
    const send = spyOn(ImapSmtpTransport.prototype, 'send').mockImplementation(async (message) => ({
      messageId: message.messageId,
      sentCopy: true,
      accepted: message.to,
      rejected: [],
    }));
    try {
      const registry = await configuredConnectors({
        sql: context.sql,
        workRoot: context.workRoot,
        spacesRoot: context.spacesRoot,
        masterKey,
        connections: [
          {
            kind: 'email',
            id: a.connectionId,
            username: 'a@example.test',
            from: 'a@example.test',
            imap: { host: 'imap.example.test', port: 993, secure: true },
            smtp: { host: 'smtp.example.test', port: 465, secure: true },
          },
        ],
      });
      const broker = new BrokerService({ sql: context.sql, connectors: registry });
      const request = {
        kind: 'artifact.publish',
        connection_id: context.publishConnection,
        payload: {
          path: 'mail.txt',
          destination: { kind: 'email', to: 'owner@example.test', subject: 'B artifact' },
        },
      };
      let refusal: unknown;
      try {
        const proposal = await broker.propose(context.claims, request);
        await broker.decide(proposal.action_id, {
          decision: 'approved',
          payload_hash: proposal.payload_hash,
        });
        await broker.propose(context.claims, request);
      } catch (error) {
        refusal = error;
      }
      expect(send).not.toHaveBeenCalled();
      expect(refusal).toMatchObject({ code: 'scope_denied' });
    } finally {
      send.mockRestore();
    }
  },
  SLOW,
);

databaseTest(
  'a CSV whose totals do not add up cannot complete the job',
  async () => {
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

    const failing = await artifactGate(fixture?.db as never, context.claims.job_id, context);
    expect(failing.passed).toBe(false);
    expect(failing.failures.join(' ')).toContain('totals:amount');
    expect(failing.failures.join(' ')).toContain('91.5');

    // The job asks to complete, and the state machine sends it to the owner with
    // the arithmetic named rather than recording a deliverable that is wrong.
    const before = await facts(context.claims.job_id, context);
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
    const after = await facts(context.claims.job_id, context);
    expect(after.artifact_validations_passed).toBe(true);
    expect(after.artifact_failures).toEqual([]);
    const both = await context.sql`select id from artifact where job_id = ${context.claims.job_id}`;
    expect(both).toHaveLength(2);
  },
  SLOW,
);

async function facts(jobId: string, roots: { workRoot: string; spacesRoot: string }) {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  return fixture.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: jobTable.id, spaceId: jobTable.spaceId, constraints: jobTable.constraints })
      .from(jobTable)
      .where(eq(jobTable.id, jobId));
    if (!row) throw new Error('no job row');
    return completionFacts(
      tx,
      row as never,
      {
        kind: 'completed',
        summary: 'done',
        evidence: [],
      },
      roots,
    );
  });
}

databaseTest(
  'a declared human acceptance blocks until the owner gives it',
  async () => {
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
    const waiting = await artifactGate(fixture?.db as never, context.claims.job_id, context);
    expect(waiting.passed).toBe(false);
    expect(waiting.failures.join(' ')).toContain('human is still waiting');

    const [row] =
      await context.sql`select id from artifact where job_id = ${context.claims.job_id}`;
    const accepted = await acceptArtifact(context.sql, {
      artifact_id: String(row?.id),
      decision: 'accepted',
    });
    expect(accepted.status).toBe('passed');
    const done = await artifactGate(fixture?.db as never, context.claims.job_id, context);
    expect(done.passed).toBe(true);
  },
  SLOW,
);

databaseTest(
  'a critique with no configured critic is recorded as unavailable',
  async () => {
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
    expect((await artifactGate(fixture?.db as never, context.claims.job_id, context)).passed).toBe(
      true,
    );
  },
  SLOW,
);

databaseTest(
  'an execution is on the ledger without anyone being asked',
  async () => {
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
  },
  SLOW,
);

databaseTest(
  'a truncated execution stores its output as an artifact of the job',
  async () => {
    const context = await setup();
    const content = 'output '.repeat(4000);
    const stored = path.join(context.workRoot, context.claims.job_id, '.melete', 'exec', 'run.log');
    await Bun.write(stored, content);
    const hash = new Bun.CryptoHasher('sha256').update(content).digest('hex');
    const proposal = await context.broker.propose(context.claims, {
      kind: 'exec.run',
      connection_id: context.execConnection,
      payload: {
        language: 'shell',
        command: 'echo lots',
        cwd: '.',
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 80,
        output_digest: hash,
        output_bytes: content.length,
        truncated: true,
        output_path: '.melete/exec/run.log',
      },
      client_ref: 'exec-truncated',
    });
    expect(proposal.status).toBe('succeeded');
    const [row] = await context.sql`select id, path, kind, size, content_hash, source_job_id
    from artifact where job_id = ${context.claims.job_id} and path = '.melete/exec/run.log'`;
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('text');
    expect(row?.content_hash).toBe(hash);
    expect(row?.source_job_id).toBe(context.claims.job_id);
    // Nothing was promised about the contents of an arbitrary command's output,
    // so recording it cannot be what stops the job from finishing.
    expect((await artifactGate(fixture?.db as never, context.claims.job_id, context)).passed).toBe(
      true,
    );
  },
  SLOW,
);

databaseTest(
  'an execution claiming another job workspace is refused at the ledger',
  async () => {
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
  },
  SLOW,
);

databaseTest(
  'publishing is approved once and leaves a receipt linked to the record',
  async () => {
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
  },
  SLOW,
);

databaseTest(
  'a file that changed since it was recorded is not published',
  async () => {
    const context = await setup();
    await context.broker.propose(context.claims, {
      kind: 'files.write',
      connection_id: context.connectionId,
      payload: { path: 'report.csv', content: csv('40.00'), expect: totalsExpectation },
      client_ref: 'write-drift',
    });
    // Someone rewrote the bytes without declaring anything: the record and the
    // file no longer agree, and an approval given over the record is void.
    await Bun.write(
      path.join(context.workRoot, context.claims.job_id, 'report.csv'),
      csv('999.00'),
    );
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
    const attempted = await rejectionOf(context.broker.propose(context.claims, request));
    expect(attempted).toMatchObject({ code: 'payload_invalid' });
    const [action] = await context.sql`select status from action where id = ${parked.action_id}`;
    expect(action?.status).toBe('approved');
  },
  SLOW,
);

databaseTest(
  'a publish by email attaches the recorded bytes, not payload bytes',
  async () => {
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
  },
  SLOW,
);

databaseTest(
  'a file with no artifact record cannot be published at all',
  async () => {
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
    const attempted = await rejectionOf(context.broker.propose(context.claims, request));
    expect(attempted).toMatchObject({ code: 'payload_invalid' });
    const stored = await fixture?.db
      .select()
      .from(artifactTable)
      .where(eq(artifactTable.jobId, context.claims.job_id));
    expect(stored).toHaveLength(0);
  },
  SLOW,
);
