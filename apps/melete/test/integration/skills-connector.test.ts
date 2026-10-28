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
import { appendEvent, loadAction, recordId } from '../../src/broker/records.ts';
import { planReversal, undoDecides } from '../../src/broker/reversals.ts';
import { type BrokerOptions, BrokerService } from '../../src/broker/service.ts';
import { createSkillsConnector, skillsManifest } from '../../src/connectors/skills.ts';
import { shownRecord } from '../../src/workers/browser/routes.ts';
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

  async function setup(
    spaceKind: 'personal' | 'shared' = 'personal',
    grants: Pick<BrokerOptions, 'resolveStandingGrant' | 'resolveScopedGrant'> = {},
  ) {
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
      ...grants,
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

  /** A statement skill drafted from the steps a person showed in the browser. */
  const STATEMENT = {
    name: 'monthly-statement',
    description: 'Download this month’s bank statement, the way the person showed it.',
    triggers: ['this month’s statement', 'monthly statement'],
    body: [
      '1. Open the bank site’s Statements page (link "Statements").',
      '2. Press the button for the month asked for, then "Download PDF".',
    ].join('\n'),
  };
  /**
   * The handback's record, read by the attempt `s.claims` names: its input reaches past it, as
   * the next attempt's does when it starts after the person handed back.
   */
  const showSteps = async (s: Awaited<ReturnType<typeof setup>>, epoch = 3) => {
    await appendEvent(
      s.db,
      s.claims.job_id,
      null,
      'notice',
      shownRecord(
        'brws_fixture',
        epoch,
        [
          { kind: 'click', role: 'link', name: 'Statements', title: 'Accounts' },
          { kind: 'click', role: 'button', name: 'Download PDF', title: 'Statements' },
        ],
        false,
      ),
      `shown:${s.claims.job_id}:${epoch}`,
    );
    await s.db`update attempt set input_cursor = (select max(seq) from event where job_id = ${s.claims.job_id})
      where id = ${s.claims.attempt_id}`;
  };
  /** The same work's next attempt, which starts after the one before it ended. */
  const nextAttempt = async (s: Awaited<ReturnType<typeof setup>>) => {
    const epoch = s.claims.epoch + 1;
    const attemptId = recordId('att');
    await s.db`update attempt set outcome = 'completed', ended_at = now() where id = ${s.claims.attempt_id}`;
    await s.db`insert into attempt (id, job_id, epoch, runtime_version, provider, model, input_cursor)
      values (${attemptId}, ${s.claims.job_id}, ${epoch}, 'fake', 'fake', 'scripted',
        (select max(seq) from event where job_id = ${s.claims.job_id}))`;
    await s.db`update job set lease_epoch = ${epoch} where id = ${s.claims.job_id}`;
    return { ...s.claims, epoch, attempt_id: attemptId };
  };

  test('a skill drafted from shown steps waits for the person, records where it came from, and is discarded in one answer', async () => {
    const s = await setup();
    await showSteps(s);
    const file = (name: string) =>
      readFile(path.join(s.skillsDir, name, 'SKILL.md'), 'utf8').catch(() => null);

    const asked = await s.call('skills.create', STATEMENT);
    expect(asked.status).toBe('needs_approval');
    expect(asked.approval_id).toBeTruthy();
    const [row] = await s.db`select canonical_payload from action where id = ${asked.action_id}`;
    expect(row?.canonical_payload.shown).toBe('shown_brws_fixture_3');
    expect(await file(STATEMENT.name)).toBeNull();
    // Discarding is the one answer: nothing is saved.
    await s.broker.decide(asked.action_id, {
      decision: 'denied',
      payload_hash: asked.payload_hash,
    });
    expect(await file(STATEMENT.name)).toBeNull();

    // Drafted again and confirmed, it is saved with its provenance, where the loader reads it.
    const again = await s.call('skills.create', { ...STATEMENT, name: 'statement-download' });
    expect(again.status).toBe('needs_approval');
    await s.broker.decide(again.action_id, {
      decision: 'approved',
      payload_hash: again.payload_hash,
    });
    await s.broker.admit(s.claims, again.action_id, again.payload_hash);
    expect((await s.broker.dispatch(again.action_id)).status).toBe('succeeded');
    const saved = await file('statement-download');
    expect(saved).toContain('provenance: "shown by the person"');
    const loaded = loadSkills({ spaceSkillsDirectory: s.skillsDir });
    expect(loaded.failures).toEqual([]);
    expect(loaded.skills.map((skill) => skill.frontmatter.name)).toContain('statement-download');
    const [receipt] = await s.db`select receipt from action where id = ${again.action_id}`;
    expect(receipt?.receipt.detail.provenance).toBe('shown by the person');

    // A change keeps where it came from.
    expect(
      (await s.call('skills.update', { name: 'statement-download', body: 'Shorter steps.' }))
        .status,
    ).toBe('succeeded');
    expect(await file('statement-download')).toContain('provenance: "shown by the person"');

    // That demonstration has its skill now: the next one in the same work is an ordinary save.
    expect((await s.call('skills.create', WEEKLY)).status).toBe('succeeded');
  });

  test('the agent cannot mark a skill as shown by the person, nor leave the mark off', async () => {
    const s = await setup();
    const made = await s.call('skills.create', { ...WEEKLY, shown: 'shown_made_up_1' });
    expect(made.status).toBe('succeeded');
    const [row] = await s.db`select canonical_payload from action where id = ${made.action_id}`;
    expect(row?.canonical_payload.shown).toBeUndefined();
    expect(
      await readFile(path.join(s.skillsDir, 'weekly-review', 'SKILL.md'), 'utf8'),
    ).not.toContain('provenance');

    await showSteps(s);
    const marked = await s.call('skills.create', { ...STATEMENT, shown: 'shown_made_up_1' });
    expect(marked.status).toBe('needs_approval');
    const [held] = await s.db`select canonical_payload from action where id = ${marked.action_id}`;
    expect(held?.canonical_payload.shown).toBe('shown_brws_fixture_3');
  });

  test('a skill drafted from shown steps asks the person whatever standing or scoped grant exists', async () => {
    const s = await setup('personal', {
      resolveStandingGrant: async () => true,
      resolveScopedGrant: async () => 'apr_standing',
    });
    // An ordinary skill goes through as before.
    expect((await s.call('skills.create', WEEKLY)).status).toBe('succeeded');
    await showSteps(s);
    const asked = await s.call('skills.create', STATEMENT);
    expect(asked.status).toBe('needs_approval');
    expect(asked.approval_id).toBeTruthy();
    expect(
      await readFile(path.join(s.skillsDir, STATEMENT.name, 'SKILL.md'), 'utf8').catch(() => null),
    ).toBeNull();
  });

  test('only the attempt the steps were given to has its skill marked, and only until one is saved', async () => {
    const s = await setup();
    await showSteps(s);
    // Another conversation in the same space was never shown these steps.
    const otherJob = recordId('job');
    const otherAttempt = recordId('att');
    await s.db`insert into job (id, space_id, title, objective, state, lease_epoch, budget, constraints)
      select ${otherJob}, space_id, title, objective, state, lease_epoch, budget, constraints
      from job where id = ${s.claims.job_id}`;
    await s.db`insert into attempt (id, job_id, epoch, runtime_version, provider, model, input_cursor)
      values (${otherAttempt}, ${otherJob}, 1, 'fake', 'fake', 'scripted',
        (select max(seq) from event))`;
    const elsewhere = await s.broker.propose(
      { ...s.claims, job_id: otherJob, attempt_id: otherAttempt },
      { kind: 'skills.create', connection_id: s.connectionId, payload: WEEKLY },
    );
    expect(elsewhere.status).toBe('succeeded');
    const [plain] =
      await s.db`select canonical_payload from action where id = ${elsewhere.action_id}`;
    expect(plain?.canonical_payload.shown).toBeUndefined();

    // The attempt that was given them never drafted a skill; a later one in the same work is not
    // drafting from steps it never read.
    const later = await nextAttempt(s);
    const afterwards = await s.broker.propose(later, {
      kind: 'skills.create',
      connection_id: s.connectionId,
      payload: { ...WEEKLY, name: 'weekly-review-two' },
    });
    expect(afterwards.status).toBe('succeeded');
    const [unmarked] =
      await s.db`select canonical_payload from action where id = ${afterwards.action_id}`;
    expect(unmarked?.canonical_payload.shown).toBeUndefined();
  });

  test('a shared space keeps no one skills', async () => {
    const s = await setup('shared');
    const refused = await rejectionOf(s.call('skills.create', WEEKLY));
    expect((refused as BrokerFault).code).toBe('scope_denied');
  });
});
