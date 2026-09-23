import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserArtifactSink } from '../../src/workers/browser/artifacts.ts';
import { planBrowserRecipe } from '../../src/workers/browser/planning.ts';
import {
  type BrowserRecipeCandidate,
  PostgresBrowserRecipeStore,
  type VisibleSchema,
} from '../../src/workers/browser/recipes.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const databaseTest = database ? test : test.skip;
afterAll(async () => {
  await database?.close();
}, 15_000);

function handle() {
  if (!database) throw new Error('Postgres unavailable');
  return database;
}

const recorded: VisibleSchema = [
  { label: 'Name', role: 'textbox', required: true, sensitive: false },
  { label: 'Save', role: 'button', required: false, sensitive: false },
];
const changed: VisibleSchema = [
  ...recorded,
  { label: 'Birth year', role: 'textbox', required: false, sensitive: false },
];

async function checkedRecipe() {
  const { sql } = handle();
  const { claims } = await seedJob(sql, { provider: 'web' });
  const store = new PostgresBrowserRecipeStore(sql);
  const recipe: BrowserRecipeCandidate = {
    id: 'recipe_contact',
    space_id: claims.space_id,
    version: 1,
    state: 'candidate',
    schema: recorded,
    steps: [
      { action: 'fill', label: 'Name', value_key: 'name' },
      { action: 'submit', role: 'button', name: 'Save' },
    ],
    safe_aliases: {},
    reason: 'recorded',
  };
  await store.save(recipe);
  await store.save({ ...recipe, state: 'validated' });
  const bind = (sessionId: string, control: 'automation' | 'human') =>
    sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
      values (${sessionId}, ${claims.space_id}, ${claims.job_id}, 1, ${control})
      on conflict (id) do update set control = excluded.control,
        control_epoch = browser_session_binding.control_epoch + 1, updated_at = clock_timestamp()`;
  return { claims, store, recipe, bind };
}

describe('what a takeover leaves behind in the service', () => {
  databaseTest('a recipe candidate is not created for a takeover', async () => {
    const { claims, store, recipe, bind } = await checkedRecipe();
    await bind('brws_live_privacy', 'human');
    expect(await planBrowserRecipe(store, claims.space_id, recipe.id, 1, changed)).toEqual({
      disposition: 'stop',
      reason: 'human_control',
      steps: [],
      aliases_used: 0,
    });
    // Settled by hand: Bun's expect().rejects waits without serving the database socket.
    const direct = await store
      .save({ ...recipe, version: 2, state: 'candidate', schema: changed })
      .then(
        () => 'saved',
        (error: Error) => error.message,
      );
    expect(direct).toBe('recipe_frozen');
    expect((await store.list(claims.space_id)).map((row) => [row.version, row.state])).toEqual([
      [1, 'validated'],
    ]);

    // After handback the same mismatch is ordinary evidence for a repair candidate again.
    await bind('brws_live_privacy', 'automation');
    const repaired = await planBrowserRecipe(store, claims.space_id, recipe.id, 1, changed);
    expect(repaired.repair_candidate).toEqual({ id: recipe.id, version: 2, state: 'candidate' });
  });

  databaseTest(
    "only the space's most recent browser lease decides whether recipes are frozen",
    async () => {
      const { claims, store, recipe, bind } = await checkedRecipe();
      await bind('brws_closed_during_takeover', 'human');
      await bind('brws_next_lease', 'automation');
      const plan = await planBrowserRecipe(store, claims.space_id, recipe.id, 1, changed);
      expect(plan.repair_candidate?.version).toBe(2);
    },
  );

  databaseTest('an observation after handback stores its tree and no screenshot', async () => {
    const { sql } = handle();
    const { claims } = await seedJob(sql);
    const spaces = await mkdtemp(join(tmpdir(), 'melete-live-artifacts-'));
    try {
      const handles = await browserArtifactSink(sql, spaces)(claims, {
        id: 'obs_after_handback',
        url: 'https://example.test/account',
        tree: '- paragraph: Backup code: [redacted]',
        screenshot: '',
        schema: [],
      });
      expect(handles.tree).toMatchObject({ mime: 'text/plain', area: 'artifacts' });
      expect(handles.screenshot).toBeUndefined();
      const rows = await sql`select mime from artifact where job_id = ${claims.job_id}`;
      expect(rows.map((row) => row.mime)).toEqual(['text/plain']);
      const files = await readdir(join(spaces, claims.space_id, 'artifacts', 'browser'));
      expect(files).toHaveLength(1);
      expect(files[0]).toEndWith('.txt');
    } finally {
      await rm(spaces, { recursive: true, force: true });
    }
  });
});
