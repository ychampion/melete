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
import { saveApprovalSettings } from '../../src/broker/auto-review.ts';
import { loadAction, recordId } from '../../src/broker/records.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createFilesConnector } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
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
    scopes: [
      'files.write',
      'files.read',
      'files.list',
      'files.move',
      'files.delete',
      'files.restore',
    ],
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
  return { ...seed, sql, broker, registry, propose, work, files };
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
      deleted_count: 1,
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
        warning:
          'This deletes “report.pdf” from your Files. It can be restored from the trash for 7 days.',
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
          'This deletes “upload.csv”, which you gave Melete. It can be restored from the trash for 7 days.',
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

databaseTest(
  "the receipt's Undo restores everything a delete took",
  async () => {
    const ctx = await setup();
    for (let n = 0; n < 3; n += 1)
      await ctx.propose('files.write', { path: `smoke-test/f${n}.md`, content: `file ${n}` });
    const deleted = await ctx.propose('files.delete', { path: 'smoke-test' });
    expect(deleted.status).toBe('succeeded');
    expect(existsSync(ctx.work('smoke-test'))).toBe(false);
    const effects = new ExperienceEffects(ctx.sql, ctx.broker, ctx.registry);
    const receipt = await effects.receipt(
      ctx.claims.space_id,
      await loadAction(ctx.sql, deleted.action_id),
    );
    expect(receipt?.undo?.handle).toBeTruthy();
    const undone = await effects.undo(ctx.claims.space_id, receipt?.undo?.handle ?? '');
    if ('reason' in undone) throw new Error(undone.reason);
    for (let n = 0; n < 3; n += 1)
      expect(await readFile(ctx.work(`smoke-test/f${n}.md`), 'utf8')).toBe(`file ${n}`);
  },
  SLOW,
);

databaseTest(
  "with the workspace switch off, deleting Melete's own files asks too",
  async () => {
    const ctx = await setup();
    await ctx.propose('files.write', { path: 'scratch.md', content: 'mine' });
    await saveApprovalSettings(ctx.sql, ctx.claims.space_id, {
      mode: 'auto_review',
      classes: { sandbox: false },
    });
    const reviewing = new BrokerService({
      sql: ctx.sql,
      connectors: ctx.registry,
      autoReview: { reviewer: null },
    });
    const proposal = await reviewing.propose(ctx.claims, {
      kind: 'files.delete',
      connection_id: ctx.connectionId,
      payload: { path: 'scratch.md' },
    });
    expect(proposal.canonical_payload).toMatchObject({ checked: { owner: 'agent' } });
    expect(proposal.status).toBe('needs_approval');
    expect(await readFile(ctx.work('scratch.md'), 'utf8')).toBe('mine');
  },
  SLOW,
);

databaseTest(
  'a file whose save has no settled outcome yet is still the person’s, and asks',
  async () => {
    for (const status of ['dispatched', 'unknown', 'unresolved']) {
      const ctx = await setup();
      await writeFile(ctx.work('upload.csv'), 'a,b');
      await ctx.sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, status, idempotency_key)
        select ${`act_UNSETTLED${status}`}, j.id, a.id, ${ctx.connectionId}, 'files.save_attachment',
          'write_reversible', ${JSON.stringify({ attachment_id: 'file_1', path: 'upload.csv' })}::jsonb,
          'given', ${status}, ${`act_UNSETTLED${status}`}
        from job j join attempt a on a.job_id = j.id where j.id = ${ctx.claims.job_id}`;
      const proposal = await ctx.propose('files.delete', { path: 'upload.csv' });
      expect(proposal.status, status).toBe('needs_approval');
      expect(proposal.canonical_payload, status).toMatchObject({ checked: { owner: 'person' } });
      expect(existsSync(ctx.work('upload.csv')), status).toBe(true);
    }
  },
  SLOW * 2,
);

databaseTest(
  'in a chat whose agent asks before acting, a file the agent wrote is deleted unasked, Undo restores it, and so does files.restore',
  async () => {
    const ctx = await setup();
    // A chat, with an agent left at its default of asking before it acts, and
    // auto-review at its defaults: the hosted install's setting.
    const agent = recordId('agent');
    await ctx.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone, standing_instruction)
      values (${agent}, ${ctx.claims.space_id}, 'Agent', 'helper', 'blue', 'plain', 'black', 'calm', 'help')`;
    await ctx.sql`update job set kind = 'chat', agent_id = ${agent} where id = ${ctx.claims.job_id}`;
    const broker = new BrokerService({
      sql: ctx.sql,
      connectors: ctx.registry,
      autoReview: { reviewer: null },
    });
    const propose = (kind: string, payload: JsonObject) =>
      broker.propose(ctx.claims, { kind, connection_id: ctx.connectionId, payload });
    // Turn one: the agent writes a file. Workspace work goes through.
    expect((await propose('files.write', { path: 'live-n.txt', content: 'hi' })).status).toBe(
      'succeeded',
    );
    // Turn two: it deletes it. Its own file, restorable: no question.
    const deleted = await propose('files.delete', { path: 'live-n.txt' });
    expect(deleted.canonical_payload).toMatchObject({ checked: { owner: 'agent' } });
    expect(deleted.status).toBe('succeeded');
    expect(existsSync(ctx.work('live-n.txt'))).toBe(false);
    // The space's policy has moved on since the chat began, as it does on a
    // hosted install; an Undo started now still runs.
    await ctx.sql`update space set policy_generation = policy_generation + 3 where id = ${ctx.claims.space_id}`;
    // The chat's next turn is a new attempt under the new policy, as the runner makes it.
    await ctx.sql`update attempt set policy_generation = (select policy_generation from space
      where id = ${ctx.claims.space_id}) where id = ${ctx.claims.attempt_id}`;
    // The receipt offers Undo, and Undo puts it back.
    const effects = new ExperienceEffects(ctx.sql, broker, ctx.registry);
    const receipt = await effects.receipt(
      ctx.claims.space_id,
      await loadAction(ctx.sql, deleted.action_id),
    );
    expect(receipt?.undo?.handle).toBeTruthy();
    const undone = await effects.undo(ctx.claims.space_id, receipt?.undo?.handle ?? '');
    if ('reason' in undone) throw new Error(undone.reason);
    expect(await readFile(ctx.work('live-n.txt'), 'utf8')).toBe('hi');
    // Another of its files, deleted: the agent restores it itself with the receipt's trash id.
    await propose('files.write', { path: 'second.txt', content: 'two' });
    const again = await propose('files.delete', { path: 'second.txt' });
    expect(again.status).toBe('succeeded');
    const [row] = await ctx.sql`select receipt from action where id = ${again.action_id}`;
    const restored = await propose('files.restore', {
      trash_id: String(row?.receipt?.detail?.trash_id),
    });
    expect(restored.status).toBe('succeeded');
    expect(await readFile(ctx.work('second.txt'), 'utf8')).toBe('two');
    // "Restore what you deleted", with no id at hand: by its path, or the latest delete.
    await propose('files.write', { path: 'third.txt', content: 'three' });
    expect((await propose('files.delete', { path: 'third.txt' })).status).toBe('succeeded');
    const byPath = await propose('files.restore', { path: 'third.txt' });
    expect(byPath.status).toBe('succeeded');
    expect(await readFile(ctx.work('third.txt'), 'utf8')).toBe('three');
    await propose('files.write', { path: 'fourth.txt', content: 'four' });
    expect((await propose('files.delete', { path: 'fourth.txt' })).status).toBe('succeeded');
    const latest = await propose('files.restore', {});
    expect(latest.status).toBe('succeeded');
    expect(await readFile(ctx.work('fourth.txt'), 'utf8')).toBe('four');
    // Nothing left to restore says so plainly.
    expect(String((await rejectionOf(propose('files.restore', {}))) as Error)).toContain(
      'nothing deleted in this conversation is still in the trash',
    );
    // The person's own file still asks.
    await writeFile(ctx.files('theirs.pdf'), 'theirs');
    expect((await propose('files.delete', { path: 'theirs.pdf', area: 'artifacts' })).status).toBe(
      'needs_approval',
    );
  },
  SLOW,
);
