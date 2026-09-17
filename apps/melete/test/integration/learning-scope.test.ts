import { afterAll, describe, expect, test } from 'bun:test';
import { RESERVED_TASK_FAMILIES } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { learningJob } from '../../src/learning/schema.ts';
import {
  GENERAL_APP,
  GENERAL_APP_VERSION,
  GENERAL_FAMILY,
  objectiveTemplate,
} from '../../src/learning/scope.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { learningFixture, learningScope, rejectsWith } from './learning-fixtures.ts';

const fixture = await learningFixture();
afterAll(async () => {
  await fixture?.close();
}, 15000);

(fixture ? describe : describe.skip)('a learning scope for every owned job', () => {
  test('general scope is registered for a chat job with no learning field', async () => {
    if (!fixture) return;
    const objective = 'Draft a short reply to the building manager';
    const row = await principalContext.run(fixture.ownerId, () =>
      fixture.jobs.transaction((tx) =>
        fixture.jobs.createInTransaction(
          tx,
          { space_id: fixture.spaceId, title: 'Chat', objective },
          { kind: 'chat' },
        ),
      ),
    );
    expect(row.principalId).toBe(fixture.ownerId);
    const [registered] = await fixture.handle.db
      .select()
      .from(learningJob)
      .where(eq(learningJob.jobId, row.id));
    expect(registered?.scope).toEqual({
      task_family: GENERAL_FAMILY,
      app: GENERAL_APP,
      app_version: GENERAL_APP_VERSION,
      role: 'owner',
      audience: 'private',
    });
    expect(registered?.templateId).toBe(objectiveTemplate(objective));
    expect(registered?.inputRefs).toEqual([]);
    await fixture.jobs.cancel(row.id);
  }, 15000);

  test('a public compartment job registers no learning scope', async () => {
    if (!fixture) return;
    const row = await principalContext.run(fixture.ownerId, () =>
      fixture.jobs.create({
        space_id: fixture.spaceId,
        title: 'Public',
        objective: 'Answer a question in the open compartment',
        constraints: { public_compartment: true },
      }),
    );
    const registered = await fixture.handle.db
      .select()
      .from(learningJob)
      .where(eq(learningJob.jobId, row.id));
    expect(registered).toHaveLength(0);
    await fixture.jobs.cancel(row.id);
  }, 15000);

  test('the objective template is stable across whitespace and case', async () => {
    if (!fixture) return;
    expect(objectiveTemplate('  Summarise   the Weekly Report, please! ')).toBe(
      objectiveTemplate('summarise the weekly report please'),
    );
    expect(objectiveTemplate('Summarise the weekly report')).not.toBe(
      objectiveTemplate('Summarise the monthly report'),
    );
    expect(objectiveTemplate('anything at all')).toMatch(/^obj\.[0-9a-f]{32}$/);
    const objective = 'Collect   the OPEN questions';
    const rows = await principalContext.run(fixture.ownerId, async () => [
      await fixture.jobs.create({ space_id: fixture.spaceId, title: 'A', objective }),
      await fixture.jobs.create({
        space_id: fixture.spaceId,
        title: 'B',
        objective: 'collect the open questions',
      }),
    ]);
    const registered = await Promise.all(
      rows.map(
        async (row) =>
          (
            await fixture.handle.db.select().from(learningJob).where(eq(learningJob.jobId, row.id))
          )[0],
      ),
    );
    expect(registered[0]?.templateId).toBe(registered[1]?.templateId);
    for (const row of rows) await fixture.jobs.cancel(row.id);
  }, 15000);

  test('a reserved task family is refused', async () => {
    if (!fixture) return;
    expect(RESERVED_TASK_FAMILIES).toContain('procedure-scope');
    for (const family of RESERVED_TASK_FAMILIES) {
      const row = await fixture.jobs.create({
        space_id: fixture.spaceId,
        title: 'Forge',
        objective: 'Claim a synthetic evaluation family',
      });
      await expect(
        fixture.episodes.setScope(fixture.ownerId, row.id, {
          scope: { ...learningScope, task_family: family },
          template_id: 'forged',
        }),
      ).rejects.toThrow();
      await expect(
        fixture.jobs.create({
          space_id: fixture.spaceId,
          title: 'Forge at creation',
          objective: 'Claim a synthetic evaluation family at creation',
          learning: {
            scope: { ...learningScope, task_family: family },
            template_id: 'forged',
            input_refs: [],
          },
        }),
      ).rejects.toThrow();
      const registered = await fixture.handle.db
        .select()
        .from(learningJob)
        .where(eq(learningJob.jobId, row.id));
      expect(registered.map((entry) => entry.scope.task_family)).not.toContain(family);
      await fixture.jobs.cancel(row.id);
    }
    // The ordinary family still registers, so the refusal is the reserved name and not the route.
    const allowed = await fixture.jobs.create({
      space_id: fixture.spaceId,
      title: 'Ordinary',
      objective: 'Arrange the supplied records',
    });
    const saved = await fixture.episodes.setScope(fixture.ownerId, allowed.id, {
      scope: learningScope,
      template_id: 'reserved-control',
    });
    expect(saved.scope).toEqual(learningScope);
    await rejectsWith(
      () =>
        fixture.episodes.setScope(fixture.ownerId, allowed.id, {
          scope: learningScope,
          template_id: 'a-different-template',
        }),
      'scope_frozen',
    );
    await fixture.jobs.cancel(allowed.id);
  }, 20000);
});
