/**
 * `files.delete` through the broker against a real database: what the agent
 * made in this conversation goes without a question and leaves a receipt; a
 * file the person owns or gave waits for them, goes when they agree and stays
 * when they decline.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonObject } from '@melete/contracts';
import { BrokerService } from '../../src/broker/service.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const SLOW = 30_000;

afterAll(async () => {
  await fixture?.close();
}, 15_000);

async function setup() {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const { sql } = fixture;
  const seed = await seedJob(sql, {
    scopes: ['files.write', 'files.read', 'files.list', 'files.move', 'files.delete'],
    provider: 'files',
  });
  const roots = await mkdtemp(path.join(tmpdir(), 'melete-files-delete-'));
  const workRoot = path.join(roots, 'work');
  const spacesRoot = path.join(roots, 'spaces');
  await Bun.write(path.join(workRoot, seed.claims.job_id, '.keep'), '');
  await Bun.write(path.join(spacesRoot, seed.claims.space_id, 'artifacts', '.keep'), '');
  const registry = new ConnectorRegistry().register(
    seed.connectionId,
    createFilesConnector({ workRoot, spacesRoot, sql }),
  );
  const broker = new BrokerService({ sql, connectors: registry });
  const propose = (kind: string, payload: JsonObject) =>
    broker.propose(seed.claims, { kind, connection_id: seed.connectionId, payload });
  const work = (name: string) => path.join(workRoot, seed.claims.job_id, name);
  const files = (name: string) => path.join(spacesRoot, seed.claims.space_id, 'artifacts', name);
  return { ...seed, sql, broker, propose, work, files };
}

databaseTest(
  'a folder the agent made is deleted without asking, with a receipt',
  async () => {
    const ctx = await setup();
    expect(
      (await ctx.propose('files.write', { path: 'smoke-test/notes.md', content: 'hello' })).status,
    ).toBe('succeeded');
    const deleted = await ctx.propose('files.delete', { path: 'smoke-test' });
    expect(deleted.status).toBe('succeeded');
    expect(existsSync(ctx.work('smoke-test'))).toBe(false);
    const [row] = await ctx.sql`select receipt from action where id = ${deleted.action_id}`;
    expect(row?.receipt?.detail).toMatchObject({
      path: 'smoke-test',
      area: 'work',
      deleted: 'folder',
      files: 1,
      owner: 'agent',
    });
    // A new file it saved in the person's Files is its own too, while unchanged.
    expect(
      (await ctx.propose('files.write', { path: 'scratch.txt', area: 'artifacts', content: 'x' }))
        .status,
    ).toBe('succeeded');
    const own = await ctx.propose('files.delete', { path: 'scratch.txt', area: 'artifacts' });
    expect(own.status).toBe('succeeded');
    expect(existsSync(ctx.files('scratch.txt'))).toBe(false);
  },
  SLOW,
);

databaseTest(
  "a person's file asks first: kept when they decline, deleted when they approve",
  async () => {
    const ctx = await setup();
    await writeFile(ctx.files('report.pdf'), 'theirs');
    const declined = await ctx.propose('files.delete', { path: 'report.pdf', area: 'artifacts' });
    expect(declined.status).toBe('needs_approval');
    expect(declined.canonical_payload).toMatchObject({
      checked: {
        owner: 'person',
        warning: 'This permanently deletes “report.pdf” from your Files. It cannot be undone.',
      },
    });
    await ctx.broker.decide(declined.action_id, {
      decision: 'denied',
      payload_hash: declined.payload_hash,
    });
    expect(
      await rejectionOf(ctx.broker.admit(ctx.claims, declined.action_id, declined.payload_hash)),
    ).toMatchObject({ code: 'approval_denied' });
    expect((await ctx.broker.dispatch(declined.action_id)).status).toBe('denied');
    expect(await readFile(ctx.files('report.pdf'), 'utf8')).toBe('theirs');

    // Approved, in another conversation: it goes, with a receipt.
    const other = await setup();
    await writeFile(other.work('upload.csv'), 'a,b');
    // The workspace file the person gave the agent asks the same way.
    await other.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
        canonical_payload, payload_hash, status, idempotency_key, receipt, resolved_at)
      select 'act_GIVEN', j.id, a.id, ${other.connectionId}, 'files.save_attachment',
        'write_reversible', ${JSON.stringify({ attachment_id: 'file_1', path: 'upload.csv' })}::jsonb,
        'given', 'succeeded', 'act_GIVEN', ${JSON.stringify({ detail: { path: 'upload.csv' } })}::jsonb,
        now()
      from job j join attempt a on a.job_id = j.id where j.id = ${other.claims.job_id}`;
    const approved = await other.propose('files.delete', { path: 'upload.csv' });
    expect(approved.status).toBe('needs_approval');
    expect(approved.canonical_payload).toMatchObject({
      checked: {
        owner: 'person',
        warning:
          'This permanently deletes “upload.csv”, which you gave Melete. It cannot be undone.',
      },
    });
    expect(existsSync(other.work('upload.csv'))).toBe(true);
    await other.broker.decide(approved.action_id, {
      decision: 'approved',
      payload_hash: approved.payload_hash,
    });
    await other.broker.admit(other.claims, approved.action_id, approved.payload_hash);
    expect((await other.broker.dispatch(approved.action_id)).status).toBe('succeeded');
    expect(existsSync(other.work('upload.csv'))).toBe(false);
    const [row] = await other.sql`select receipt from action where id = ${approved.action_id}`;
    expect(row?.receipt?.detail).toMatchObject({ path: 'upload.csv', owner: 'person' });
  },
  SLOW,
);

databaseTest(
  'a file the person changed after approving is not deleted',
  async () => {
    const ctx = await setup();
    await writeFile(ctx.files('plan.md'), 'first');
    const proposal = await ctx.propose('files.delete', { path: 'plan.md', area: 'artifacts' });
    expect(proposal.status).toBe('needs_approval');
    await ctx.broker.decide(proposal.action_id, {
      decision: 'approved',
      payload_hash: proposal.payload_hash,
    });
    await writeFile(ctx.files('plan.md'), 'rewritten since');
    const refused = await rejectionOf(
      ctx.broker.admit(ctx.claims, proposal.action_id, proposal.payload_hash),
    );
    expect(String((refused as Error).message)).toContain('changed after this delete was decided');
    expect(await readFile(ctx.files('plan.md'), 'utf8')).toBe('rewritten since');
  },
  SLOW,
);
