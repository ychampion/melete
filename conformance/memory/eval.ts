/**
 * `bun run conformance:memory:eval`.
 *
 * The memory evaluation. Where the conformance scenarios each prove one rule,
 * these fixtures are conversations a person might have over a few weeks, and
 * the questions are phrased the way a later request would be ("Email Ana the
 * agenda"), not as the key the answer sits under. Each check is counted by what
 * it measures:
 *
 * - stored: after the conversation, memory holds what was said, once, with the
 *   latest correction as the value;
 * - recalled: a later attempt, with the profile and the attempt's knowledge
 *   budget, is handed the value it needs;
 * - erased: after a removal, no memory table in the space still holds the text;
 * - irrelevant: memory that has nothing to do with the request stays out;
 * - told: the conversation shows what memory did as tool entries.
 *
 * Extraction and answers are scripted, as in the conformance runner, so the
 * numbers describe what the memory service keeps and serves, not how well a
 * model reads a conversation.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CheckKind, ScenarioRun } from './harness.ts';
import { openHarness } from './harness.ts';
import { loadScenarios } from './run.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = (line = '') => process.stdout.write(`${line}\n`);
const KINDS: CheckKind[] = ['stored', 'recalled', 'erased', 'irrelevant', 'told'];

export type EvalTotals = Record<CheckKind, { passed: number; total: number }>;

export function evalTotals(runs: readonly ScenarioRun[]): EvalTotals {
  const totals = Object.fromEntries(
    KINDS.map((kind) => [kind, { passed: 0, total: 0 }]),
  ) as EvalTotals;
  for (const run of runs)
    for (const check of run.checks) {
      if (!check.kind) continue;
      totals[check.kind].total++;
      if (check.ok) totals[check.kind].passed++;
    }
  return totals;
}

async function main() {
  const scenarios = await loadScenarios(`${here}eval`, { requireEveryFamily: false });
  const harness = await openHarness({ providerPort: 3132 });
  if (!harness) {
    out('db tests skipped: set DATABASE_URL to run the memory evaluation against Postgres');
    return 0;
  }
  const runs: ScenarioRun[] = [];
  try {
    for (const scenario of scenarios) {
      const run = await harness.run(scenario, 'memory');
      runs.push(run);
      out(`${run.outcome.padEnd(6)} ${scenario.id} (${run.duration_ms} ms)`);
      for (const failure of run.failures) out(`       ${failure}`);
    }
  } finally {
    await harness.close();
  }
  const totals = evalTotals(runs);
  out();
  for (const kind of KINDS) {
    const { passed, total } = totals[kind];
    const rate = total ? `${((100 * passed) / total).toFixed(1)}%` : '-';
    out(`${kind.padEnd(10)} ${String(passed).padStart(3)}/${String(total).padEnd(3)} ${rate}`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    totals,
    scenarios: runs.map((run) => ({
      id: run.id,
      outcome: run.outcome,
      failures: run.failures,
    })),
  };
  await writeFile(`${here}eval-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  out('report written to conformance/memory/eval-report.json');
  return runs.some((run) => run.outcome === 'failed') ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
