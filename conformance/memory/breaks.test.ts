/**
 * The runner's own falsifier.
 *
 * A suite nobody has watched fail is a suite nobody has a reason to believe. So
 * this turns three of the memory rules off on purpose, through the clearly
 * marked test-only seams in `apps/melete/src/memory/seams.ts`, and asserts that
 * the scenarios resting on each one go red. Then it turns the rule back on and
 * asserts the same scenario is green again, so a red row here is evidence about
 * the rule and not about the harness.
 *
 * The three breaks are the three failure modes E6 names: a late import winning,
 * an extractor citing a convenient nearby message, and a forgotten fact coming
 * back after a restore.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  memorySeams,
  resetMemorySeams,
  setMemorySeams,
} from '../../apps/melete/src/memory/seams.ts';
import { type Harness, openHarness, type ScenarioRun } from './harness.ts';
import { loadScenarios } from './run.ts';
import type { Scenario } from './schema.ts';

const scenarios = await loadScenarios();
const find = (id: string): Scenario => {
  const found = scenarios.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`no memory scenario ${id}`);
  return found;
};

// Ports of their own, so this can run beside the integration suite's fixtures.
const harness: Harness = await openHarness({ databasePort: 3128, providerPort: 3129 });
// Dropping a disposable database and stopping an embedded cluster is slower
// than the default hook budget on Windows, so this one says how long it may take.
afterAll(async () => {
  resetMemorySeams();
  await harness?.close();
}, 60_000);
const withDb = harness ? describe : describe.skip;
const run = async (id: string): Promise<ScenarioRun> => {
  if (!harness) throw new Error('no harness');
  return harness.run(find(id), 'memory');
};

withDb('the memory runner goes red when a rule is turned off', () => {
  test('a late import that wins turns the corrections family red', async () => {
    if (!harness) return;
    expect((await run('trip-july-to-august')).outcome).toBe('passed');
    // Whatever the precedence table decides to keep in history, publish instead:
    // the May email now overwrites the owner's August correction.
    setMemorySeams({
      keyedHeadDecision: (decision) =>
        decision.decision === 'historical'
          ? { decision: 'publish', reason: 'break_late_import_wins' }
          : decision,
    });
    const broken = await run('trip-july-to-august');
    expect(broken.outcome).toBe('failed');
    expect(broken.failures.join('\n')).toContain('12 August 2026');
    expect(broken.metrics.obsolete_fact_used).toBeGreaterThan(0);
    resetMemorySeams();
    expect((await run('trip-july-to-august')).outcome).toBe('passed');
  }, 120000);

  test('accepting a nearby-message citation turns the source-authority family red', async () => {
    if (!harness) return;
    expect((await run('no-nearby-message-citation')).outcome).toBe('passed');
    // The span check is what stops a value being attached to evidence that does
    // not contain it. Without it the newsletter acquires the owner's date.
    setMemorySeams({ acceptForeignCitation: true });
    const broken = await run('no-nearby-message-citation');
    expect(broken.outcome).toBe('failed');
    expect(broken.failures.join('\n')).toContain('event.expo.date');
    resetMemorySeams();
    expect((await run('no-nearby-message-citation')).outcome).toBe('passed');
  }, 120000);

  test('skipping the restriction replay turns the forgetting family red', async () => {
    if (!harness) return;
    expect((await run('forget-survives-restore')).outcome).toBe('passed');
    // Restore without replaying the retained journal, which is exactly how a
    // forgotten fact comes back out of an older database snapshot.
    setMemorySeams({ skipRestrictionReplay: true });
    const broken = await run('forget-survives-restore');
    expect(broken.outcome).toBe('failed');
    expect(broken.failures.join('\n')).toContain('contact.clinic.phone');
    resetMemorySeams();
    expect((await run('forget-survives-restore')).outcome).toBe('passed');
  }, 120000);

  test('every rule is back on', () => {
    resetMemorySeams();
    expect(Object.keys({ ...memorySeams() })).toEqual([]);
  });
});
