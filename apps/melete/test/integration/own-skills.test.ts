/**
 * A person provisioned after setup opens Memory › Lessons and skills: what
 * they taught Melete loads, and so do the skills they asked it to make, which
 * they can read whole, change and delete. Another person, or a shared space,
 * reaches none of it. Real Postgres, and the routes as the service mounts them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { learnedList } from '@melete/contracts';
import { Hono } from 'hono';
import { ServiceError } from '../../src/api/errors.ts';
import { skillFile } from '../../src/connectors/skills.ts';
import { principal, space } from '../../src/db/schema.ts';
import { EngineSkillService } from '../../src/learning/engine-skills.ts';
import { requireLearningSpace } from '../../src/learning/episodes.ts';
import { LearnedService } from '../../src/learning/learned.ts';
import { EngineSource } from '../../src/learning/learned-engine.ts';
import { mountOwnSkills } from '../../src/learning/own-skills-routes.ts';
import { ProcedureService } from '../../src/learning/procedures.ts';
import { newId, provisionMemorySpace } from '../../src/memory/db.ts';
import { learningFixture, rejectsWith } from './learning-fixtures.ts';

const fixture = await learningFixture();
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await fixture?.close();
}, 30000);

const WEEKLY = {
  name: 'weekly-recap',
  description: 'Write the Friday recap of what shipped and what is next.',
  triggers: ['weekly recap'],
  tools: [],
  body: '1. List what shipped.\n2. Say what is open.',
};

(fixture ? describe : describe.skip)("a provisioned person's lessons and skills", () => {
  /** A person added after setup, with a personal space of their own, as `POST /principals` makes one. */
  async function person(kind: 'personal' | 'shared' = 'personal') {
    if (!fixture) throw new Error('No database');
    const id = newId('prn');
    await fixture.handle.db.insert(principal).values({ id, email: `${id}@example.test` });
    const spaceId = newId('sp');
    await fixture.handle.db.insert(space).values({
      id: spaceId,
      name: 'Personal',
      gitPath: `test/${spaceId}`,
      kind,
      ownerPrincipalId: id,
    });
    // Memory stores every space under the installation's owner, whoever owns the space.
    await provisionMemorySpace(fixture.handle.sql, fixture.ownerId, spaceId);
    await fixture.handle
      .sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
    return { id, spaceId };
  }

  async function routes(spacesRoot: string, as: string) {
    if (!fixture) throw new Error('No database');
    const app = new Hono();
    app.onError((error, c) =>
      error instanceof ServiceError
        ? c.json({ error: { code: error.code, message: error.message } }, error.status)
        : c.json({ error: { code: 'internal_error', message: error.message } }, 500),
    );
    app.use('*', async (c, next) => {
      c.set('owner' as never, { id: as } as never);
      await next();
    });
    mountOwnSkills(app, { db: fixture.handle.db, spacesRoot });
    return (route: string, body?: unknown) =>
      app.request(route, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
  }

  test('what they taught loads for them, and for no one else', async () => {
    if (!fixture) return;
    const maya = await person();
    const learned = new LearnedService(
      fixture.jobs,
      new ProcedureService(fixture.jobs),
      fixture.episodes,
      [new EngineSource(new EngineSkillService(fixture.jobs))],
    );
    expect(learnedList.parse(await learned.list(maya.id, maya.spaceId)).items).toEqual([]);
    const other = await person();
    await rejectsWith(() => learned.list(other.id, maya.spaceId), 'scope_denied');
    // Memory that is closed stays closed to its owner too.
    const closed = await person();
    await fixture.handle
      .sql`update memory_spaces set revoked = true where space_id = ${closed.spaceId}`;
    await rejectsWith(() => learned.list(closed.id, closed.spaceId), 'scope_denied');
  }, 60000);

  test('their skills are read whole, changed against the version shown, and deleted', async () => {
    if (!fixture) return;
    const spacesRoot = await mkdtemp(path.join(tmpdir(), 'melete-own-skills-'));
    roots.push(spacesRoot);
    const maya = await person();
    const folder = path.join(spacesRoot, maya.spaceId, 'skills', WEEKLY.name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), skillFile(WEEKLY));
    const call = await routes(spacesRoot, maya.id);

    const listed = await call(`/own-skills?space_id=${maya.spaceId}`);
    expect(listed.status).toBe(200);
    const { skills } = (await listed.json()) as {
      skills: { name: string; body: string; version: string; triggers: string[] }[];
    };
    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill).toMatchObject({ name: 'weekly-recap', triggers: ['weekly recap'] });
    expect(skill?.body).toContain('List what shipped.');

    const edited = await call('/own-skills/weekly-recap/edit', {
      space_id: maya.spaceId,
      version: skill?.version,
      body: '1. List only what shipped to customers.',
      triggers: ['weekly recap', 'friday recap'],
    });
    expect(edited.status).toBe(200);
    const after = ((await edited.json()) as { skill: { version: string; body: string } }).skill;
    expect(after.body).toBe('1. List only what shipped to customers.');
    expect(await readFile(path.join(folder, 'PREVIOUS.md'), 'utf8')).toContain(
      'List what shipped.',
    );

    // A change against the version before is refused, so nothing newer is lost.
    const stale = await call('/own-skills/weekly-recap/delete', {
      space_id: maya.spaceId,
      version: skill?.version,
    });
    expect(stale.status).toBe(409);
    // A key in a skill is refused: it would be read into every turn it matches.
    const keyed = await call('/own-skills/weekly-recap/edit', {
      space_id: maya.spaceId,
      version: after.version,
      body: 'Use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789.',
    });
    expect(keyed.status).toBe(400);

    const deleted = await call('/own-skills/weekly-recap/delete', {
      space_id: maya.spaceId,
      version: after.version,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 'weekly-recap' });
    const empty = (await (await call(`/own-skills?space_id=${maya.spaceId}`)).json()) as {
      skills: unknown[];
    };
    expect(empty.skills).toEqual([]);
  }, 60000);

  test('another person and a shared space reach no one’s skills', async () => {
    if (!fixture) return;
    const spacesRoot = await mkdtemp(path.join(tmpdir(), 'melete-own-skills-'));
    roots.push(spacesRoot);
    const maya = await person();
    const sam = await person();
    const asSam = await routes(spacesRoot, sam.id);
    expect((await asSam(`/own-skills?space_id=${maya.spaceId}`)).status).toBe(403);
    const room = await person('shared');
    const asOwner = await routes(spacesRoot, room.id);
    const refused = await asOwner(`/own-skills?space_id=${room.spaceId}`);
    expect(refused.status).toBe(403);
  }, 60000);
});
