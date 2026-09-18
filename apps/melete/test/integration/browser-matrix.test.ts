import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '@melete/contracts';
import { loadAction } from '../../src/broker/records.ts';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import type { BrowserCommandResult } from '../../src/workers/browser/controller.ts';
import { browserBrokerFixture } from '../helpers/browser-broker.ts';
import { BROWSER_VARIANTS, startBrowserFixture } from '../helpers/browser-fixture.ts';
import { testDatabase } from '../helpers/database.ts';

const db = chromiumAvailable ? await testDatabase() : null;
if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
const modes = ['observe_each', 'checked_recipe'] as const;
type Measurement = {
  mode: (typeof modes)[number];
  variant: string;
  observations: number;
  local_ms: number;
  effects: number;
  disposition: string;
  reason: string;
};
const measurements: Measurement[] = [];
(db ? describe : describe.skip)('local forms through the browser broker', () => {
  let fixture: ReturnType<typeof startBrowserFixture>;
  let driver: Awaited<ReturnType<typeof browserBrokerFixture>>;
  beforeAll(async () => {
    if (!db) throw new Error('Postgres unavailable');
    fixture = startBrowserFixture();
    driver = await browserBrokerFixture(db, fixture.url);
  }, 25_000);
  afterAll(async () => {
    await driver?.close();
    await fixture?.close();
    await db?.close();
    if (measurements.length) {
      await writeFile(
        new URL('../../../../.agents/browser-measurements.json', import.meta.url),
        JSON.stringify(
          { no_model_latency: true, browser_launch_excluded: true, measurements },
          null,
          2,
        ),
      );
    }
  }, 25_000);
  for (const mode of modes)
    for (const variant of BROWSER_VARIANTS) {
      test(`${mode}: ${variant}`, async () => {
        if (!db) throw new Error('Postgres unavailable');
        await driver.resume();
        const start = performance.now();
        const counts = driver.counts();
        const run = `${mode}-${variant}`;
        const effectCount = () => fixture.effects.filter((effect) => effect.run === run).length;
        let disposition = 'completed';
        let reason = 'matched_schema';
        const record = () =>
          measurements.push({
            mode,
            variant,
            observations: driver.counts().observations - counts.observations,
            local_ms: Math.round(performance.now() - start),
            effects: effectCount(),
            disposition,
            reason,
          });
        expect(
          (await driver.call('open', { url: `${fixture.url}/form/${variant}?run=${run}` })).status,
        ).toBe('succeeded');
        expect(
          (await driver.call('observe', { recipe_id: driver.recipe.id, recipe_version: 1 })).status,
        ).toBe('succeeded');
        const plan = driver.detail()?.result?.recipe;
        expect(plan).toBeDefined();
        reason = plan?.reason ?? 'missing_plan';
        if (variant === 'unknown_required' || variant === 'ambiguous_save') {
          expect(plan?.disposition).toBe('stop');
          expect(plan?.reason).toBe(
            variant === 'unknown_required' ? 'unknown_required_field' : 'ambiguous_control',
          );
          expect(plan?.steps).toEqual([]);
          expect(driver.counts().inputs - counts.inputs).toBe(0);
          expect(effectCount()).toBe(0);
          const [job] = await db.sql`select state from job where id = ${driver.claims().job_id}`;
          expect(job?.state).toBe('waiting_for_input');
          expect(plan?.repair_candidate?.state).toBe('candidate');
          disposition = 'stopped';
          record();
          return;
        }
        expect(plan?.disposition).toBe('reuse');
        const steps = plan?.steps ?? [];
        const values = { name: 'Fixture Person', email: 'person@example.test' };
        for (const [index, step] of steps.entries()) {
          if (mode === 'observe_each') await driver.call('observe');
          if (variant === 'takeover' && index === 1) {
            const detail = driver.detail();
            if (!detail) throw new Error('No browser session');
            const worker = await driver.pool.get(driver.claims().space_id);
            const oldEpoch = detail.control_epoch;
            // Deliberately delay service notification, forcing this already planned input through
            // the broker to the changed controller epoch rather than an earlier job fence.
            await worker.takeover(detail.session_id);
            const refused = await driver.call('fill', {
              label: 'Email',
              value: 'MUST_NOT_BE_ENTERED@example.test',
            });
            expect(refused.status).toBe('failed');
            expect(refused.reconciliation).toMatchObject({ reason: 'stale_control_epoch' });
            const [job] =
              await db.sql`select state, lease_epoch from job where id = ${driver.claims().job_id}`;
            expect(job?.state).toBe('waiting_for_input');
            expect(Number(job?.lease_epoch)).toBeGreaterThan(driver.claims().epoch);
            expect(effectCount()).toBe(0);
            disposition = 'waiting_for_input';
            reason = 'stale_control_epoch';
            record();
            const returned = await driver.sessions.control(detail.session_id, 'handback');
            expect(returned.control_epoch).toBeGreaterThan(oldEpoch);
            driver.setEpoch(returned.control_epoch);
            let freshReason = '';
            try {
              await worker.request('/command', {
                session_id: detail.session_id,
                job_id: driver.claims().job_id,
                control_epoch: returned.control_epoch,
                operation: {
                  kind: 'fill',
                  label: 'Email',
                  value: 'MUST_NOT_BE_ENTERED@example.test',
                },
              });
            } catch (error) {
              freshReason = error instanceof Error ? error.message : String(error);
            }
            expect(freshReason).toBe('fresh_observation_required');
            const observation = await worker.request<BrowserCommandResult>('/command', {
              session_id: detail.session_id,
              job_id: driver.claims().job_id,
              control_epoch: returned.control_epoch,
              operation: { kind: 'observe' },
            });
            expect(observation.observation?.tree).not.toContain('MUST_NOT_BE_ENTERED');
            expect(observation.observation?.tree).toContain(values.name);
            return;
          }
          if (step.action === 'fill') {
            expect(
              (
                await driver.call('fill', {
                  label: step.label,
                  value: values[step.value_key as keyof typeof values],
                })
              ).status,
            ).toBe('succeeded');
          } else if (step.action === 'submit') {
            const intent = driver
              .detail()
              ?.result?.submit_intents?.find((intent) => intent.name === step.name);
            expect(intent).toBeDefined();
            const payload = { intent } as unknown as JsonObject;
            const proposed = await driver.call('submit', payload);
            expect(proposed.status).toBe('needs_approval');
            expect(effectCount()).toBe(0);
            const [approval] =
              await db.sql`select origin_warnings from approval where action_id = ${proposed.id}`;
            expect(approval?.origin_warnings).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ field: 'intent.url', origin_trust: 'external_content' }),
              ]),
            );
            const committed = await driver.approveAndDispatch(proposed);
            expect(committed.status).toBe('succeeded');
            expect(effectCount()).toBe(1);
            const repeated = await driver.call('submit', payload);
            expect(repeated.id).toBe(committed.id);
            expect(effectCount()).toBe(1);
            expect((await loadAction(db.sql, committed.id)).receipt).toBeTruthy();
          }
        }
        record();
      }, 25_000);
    }
  test('recipe reuse reduces observations and recipe storage has no input values or authentication factors', async () => {
    if (!db) throw new Error('Postgres unavailable');
    for (const variant of ['baseline', 'reordered', 'renamed_label']) {
      const observed = measurements.find(
        (row) => row.mode === 'observe_each' && row.variant === variant,
      );
      const recipe = measurements.find(
        (row) => row.mode === 'checked_recipe' && row.variant === variant,
      );
      expect(recipe?.disposition).toBe('completed');
      expect(recipe?.observations).toBeLessThan(observed?.observations ?? 0);
    }
    const stored = JSON.stringify(await driver.recipes.list(driver.claims().space_id));
    expect(stored).not.toContain('Fixture Person');
    expect(stored).not.toContain('person@example.test');
    expect(stored).not.toContain('MUST_NOT_BE_ENTERED');
    expect(stored).not.toContain('password');
    const detail = driver.detail();
    if (detail?.observation) {
      const text = await readFile(
        join(driver.root, driver.claims().space_id, 'artifacts', detail.observation.tree.path),
        'utf8',
      );
      expect(text.length).toBeGreaterThan(0);
    }
    expect(measurements).toHaveLength(12);
  });
  test('a hidden destination reaches the broker approval before any effect', async () => {
    if (!db) throw new Error('Postgres unavailable');
    await driver.resume();
    await driver.call('open', { url: `${fixture.url}/form/hidden_destination?run=hidden-broker` });
    await driver.call('fill', { label: 'Name', value: 'Fixture Person' });
    await driver.call('fill', { label: 'Email', value: 'person@example.test' });
    await driver.call('observe');
    const intent = driver.detail()?.result?.submit_intents?.[0];
    expect(intent?.fields.destination_picker_7).toBe('hidden@example.test');
    const proposed = await driver.call('submit', { intent } as unknown as JsonObject);
    expect(proposed.status).toBe('needs_approval');
    const [approval] =
      await db.sql`select origin_warnings from approval where action_id = ${proposed.id}`;
    expect(approval?.origin_warnings).toContainEqual(
      expect.objectContaining({
        field: 'intent.fields.destination_picker_7',
        origin_trust: 'external_content',
      }),
    );
    expect(fixture.effects.filter((effect) => effect.run === 'hidden-broker')).toHaveLength(0);
    expect((await driver.approveAndDispatch(proposed)).status).toBe('succeeded');
    expect(fixture.effects.filter((effect) => effect.run === 'hidden-broker')).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ destination_picker_7: 'hidden@example.test' }),
      }),
    ]);
  }, 25_000);
});
