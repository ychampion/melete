/**
 * A person asks the agent to make a skill ("make a skill for my weekly
 * review"). It is saved in their space without a question, in the format the
 * skill loader reads, so the next turn that mentions it is given it; a name in
 * use, a credential or another space's work is refused. Real Postgres, through
 * the broker.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JsonObject } from '@melete/contracts';
import { chooseSkills, loadSkills } from '@melete/skills';
import { BrokerFault } from '../../src/broker/errors.ts';
import { loadAction } from '../../src/broker/records.ts';
import { planReversal, undoDecides } from '../../src/broker/reversals.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createSkillsConnector, skillsManifest } from '../../src/connectors/skills.ts';
import { rejectionOf, seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const suite = fixture ? describe : describe.skip;
const SCOPES = skillsManifest.tools.map((tool) => tool.name);

const WEEKLY = {
  name: 'weekly-review',
  description: 'Run the person’s Monday weekly review of open issues and last week’s work.',
  triggers: ['weekly review', 'run my review'],
  body: [
    '1. List the open issues in the person’s repository, newest first.',
    '2. Say what closed last week and what is still open, in two short lists.',
    '3. End with the one thing most worth doing this week.',
  ].join('\n'),
};

suite("the person's own skills", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await fixture?.close();
  });

  async function setup(spaceKind: 'personal' | 'shared' = 'personal') {
    if (!fixture) throw new Error('Postgres fixture unavailable');
    const spacesRoot = await mkdtemp(path.join(tmpdir(), 'melete-skills-'));
    roots.push(spacesRoot);
    const seed = await seedJob(fixture.sql, { scopes: SCOPES, provider: 'skills' });
    if (spaceKind === 'shared')
      await fixture.sql`update space set kind = 'shared' where id = ${seed.claims.space_id}`;
    const connector = createSkillsConnector({ sql: fixture.sql, spacesRoot });
    const broker = new BrokerService({
      sql: fixture.sql,
      connectors: { get: (id: string) => (id === seed.connectionId ? connector : undefined) },
    });
    const skillsDir = path.join(spacesRoot, seed.claims.space_id, 'skills');
    const call = (kind: string, payload: JsonObject) =>
      broker.propose(seed.claims, { kind, connection_id: seed.connectionId, payload });
    return { ...seed, broker, call, skillsDir, db: fixture.sql };
  }

  test('a new skill is saved without asking, and the next turn that names it is given it', async () => {
    const s = await setup();
    const made = await s.call('skills.create', WEEKLY);
    expect(made.status).toBe('succeeded');
    expect(made.approval_id ?? null).toBeNull();

    const file = await readFile(path.join(s.skillsDir, 'weekly-review', 'SKILL.md'), 'utf8');
    expect(file).toContain('name: weekly-review');
    // What the loader reads at the start of every attempt.
    const loaded = loadSkills({ spaceSkillsDirectory: s.skillsDir });
    expect(loaded.failures).toEqual([]);
    const own = loaded.skills.find((skill) => skill.frontmatter.name === 'weekly-review');
    expect(own?.source).toBe('space');
    expect(own?.body).toContain('List the open issues');
    const chosen = chooseSkills('Run my weekly review now', 'Run my weekly review now', [
      ...loaded.skills,
    ]);
    expect(chosen.map(({ skill }) => skill.frontmatter.name)).toContain('weekly-review');

    const listed = await s.call('skills.list', {});
    expect(listed.status).toBe('succeeded');
    const [row] = await s.db`select receipt from action where id = ${listed.action_id}`;
    expect(row?.receipt.detail.skills).toEqual([
      { name: 'weekly-review', description: WEEKLY.description, triggers: WEEKLY.triggers },
    ]);
    expect(row?.receipt.detail.built_in).toContain('remember-this');
  });

  test('a name in use, a built-in name or a credential is refused before anything is saved', async () => {
    const s = await setup();
    expect((await s.call('skills.create', WEEKLY)).status).toBe('succeeded');
    for (const payload of [
      { ...WEEKLY, body: 'Something else.' },
      { ...WEEKLY, name: 'remember-this' },
      { ...WEEKLY, name: 'create' },
      {
        ...WEEKLY,
        name: 'with-token',
        body: 'Use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789.',
      },
    ]) {
      const refused = await rejectionOf(s.call('skills.create', payload));
      expect(refused).toBeInstanceOf(BrokerFault);
      expect((refused as BrokerFault).code).toBe('payload_invalid');
    }
    const file = await readFile(path.join(s.skillsDir, 'weekly-review', 'SKILL.md'), 'utf8');
    expect(file).toContain('List the open issues');
    expect(
      loadSkills({ spaceSkillsDirectory: s.skillsDir }).skills.map((x) => x.frontmatter.name),
    ).not.toContain('with-token');
  });

  test('a change keeps the words it replaces', async () => {
    const s = await setup();
    expect((await s.call('skills.create', WEEKLY)).status).toBe('succeeded');
    const changed = await s.call('skills.update', {
      name: 'weekly-review',
      body: 'Only list the issues closed last week.',
    });
    // Whether a change asks is the person's settings' call; once allowed, it lands.
    if (changed.status === 'needs_approval')
      await s.broker.decide(changed.approval_id as string, {
        decision: 'approved',
        payload_hash: changed.payload_hash,
      });
    const [landed] = await s.db`select status from action where id = ${changed.action_id}`;
    const status = landed?.status;
    expect(status).toBe('succeeded');
    const now = await readFile(path.join(s.skillsDir, 'weekly-review', 'SKILL.md'), 'utf8');
    expect(now).toContain('Only list the issues closed last week.');
    expect(now).toContain('weekly review');
    const before = await readFile(path.join(s.skillsDir, 'weekly-review', 'PREVIOUS.md'), 'utf8');
    expect(before).toContain('List the open issues');
    // The kept words are not a second skill.
    expect(
      loadSkills({ spaceSkillsDirectory: s.skillsDir }).skills.filter(
        (skill) => skill.frontmatter.name === 'weekly-review',
      ),
    ).toHaveLength(1);
    const missing = await rejectionOf(s.call('skills.update', { name: 'no-such-skill' }));
    expect((missing as BrokerFault).code).toBe('payload_invalid');
  });

  test('a skill the agent made is deleted without asking, into the trash, and put back by its undo', async () => {
    const s = await setup();
    expect((await s.call('skills.create', WEEKLY)).status).toBe('succeeded');
    const deleted = await s.call('skills.delete', { name: 'weekly-review' });
    // It stays in the person's own space and Undo puts it back, so nobody is asked.
    expect(deleted.status).toBe('succeeded');
    expect(deleted.approval_id ?? null).toBeNull();
    const names = () =>
      loadSkills({ spaceSkillsDirectory: s.skillsDir }).skills.map((x) => x.frontmatter.name);
    expect(names()).not.toContain('weekly-review');
    const [row] = await s.db`select * from action where id = ${deleted.action_id}`;
    const detail = row?.receipt.detail;
    expect(detail).toMatchObject({ name: 'weekly-review', deleted: true });
    expect(detail.trash_id).toMatch(/^del_[0-9]{13}_[0-9a-f]{12}$/);
    // The files are in the space's trash, not gone.
    const trash = path.join(
      path.dirname(s.skillsDir),
      '.trash',
      s.claims.job_id,
      detail.trash_id,
      'manifest.json',
    );
    expect(JSON.parse(await readFile(trash, 'utf8')).area).toBe('skills');

    // Its undo is the restore its receipt names, and the person's Undo decides it.
    const source = await loadAction(s.db, deleted.action_id);
    const plan = await planReversal(s.db, s.claims.space_id, source, {
      manifest: skillsManifest,
    });
    expect(plan).toMatchObject({ mode: 'reversal', kind: 'skills.restore' });
    expect(plan?.payload).toEqual({ trash_id: detail.trash_id });
    expect(plan && undoDecides(plan)).toBe(true);
    const restored = await s.call('skills.restore', plan?.payload ?? {});
    expect(restored.status).toBe('succeeded');
    expect(names()).toContain('weekly-review');
    const file = await readFile(path.join(s.skillsDir, 'weekly-review', 'SKILL.md'), 'utf8');
    expect(file).toContain('List the open issues');
  });

  test('a built-in skill or one the person does not have is not deleted', async () => {
    const s = await setup();
    for (const name of ['remember-this', 'no-such-skill']) {
      const refused = await rejectionOf(s.call('skills.delete', { name }));
      expect((refused as BrokerFault).code).toBe('payload_invalid');
    }
    const restore = await rejectionOf(s.call('skills.restore', { trash_id: 'nope' }));
    expect(restore).toBeInstanceOf(BrokerFault);
  });

  test('a shared space keeps no one skills', async () => {
    const s = await setup('shared');
    const refused = await rejectionOf(s.call('skills.create', WEEKLY));
    expect((refused as BrokerFault).code).toBe('scope_denied');
  });
});
