/**
 * `bun run conformance:memory`.
 *
 * Lists the memory scenarios, runs every one of them against the real service
 * on a disposable Postgres, then runs each `memory_required` scenario a second
 * time with recall withheld. A scenario that still passes with memory withheld
 * is not evidence about memory, so it turns the suite red with "memory not
 * exercised" rather than adding a green row.
 *
 * The output is a table per family and `conformance/memory/report.json`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';
import { type Harness, openHarness, p50, p95, type ScenarioRun } from './harness.ts';
import { FAMILIES, type Family, parseScenario, type Scenario } from './schema.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = (line = '') => process.stdout.write(`${line}\n`);

export async function loadScenarios(root = `${here}scenarios`): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  for await (const relative of new Glob('**/*.json').scan({ cwd: root })) {
    const path = `${root}/${relative}`;
    scenarios.push(parseScenario(await Bun.file(path).json(), relative));
  }
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario id ${scenario.id}`);
    seen.add(scenario.id);
  }
  const missing = FAMILIES.filter((family) => !scenarios.some((s) => s.family === family));
  if (missing.length) throw new Error(`families with no scenario: ${missing.join(', ')}`);
  return scenarios.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
}

export type FamilyRow = {
  family: Family;
  scenarios: number;
  passed: number;
  failed: number;
  todo: number;
  obsolete_fact_used: number;
  unsupported_claim: number;
  needless_question: number;
  correction_to_serving_ms: number | null;
  recall_p50_ms: number;
  recall_p95_ms: number;
};

export function familyRows(runs: readonly ScenarioRun[]): FamilyRow[] {
  return FAMILIES.map((family) => {
    const rows = runs.filter((run) => run.family === family && run.arm === 'memory');
    const corrections = rows.flatMap((run) => run.metrics.correction_to_serving_ms);
    const recalls = rows.flatMap((run) => run.metrics.recall_ms);
    return {
      family,
      scenarios: rows.length,
      passed: rows.filter((run) => run.outcome === 'passed').length,
      failed: rows.filter((run) => run.outcome === 'failed').length,
      todo: rows.filter((run) => run.outcome === 'todo').length,
      obsolete_fact_used: rows.reduce((sum, run) => sum + run.metrics.obsolete_fact_used, 0),
      unsupported_claim: rows.reduce((sum, run) => sum + run.metrics.unsupported_claim, 0),
      needless_question: rows.reduce((sum, run) => sum + run.metrics.needless_question, 0),
      correction_to_serving_ms: corrections.length ? Math.max(...corrections) : null,
      recall_p50_ms: p50(recalls),
      recall_p95_ms: p95(recalls),
    };
  });
}

const cells = (row: FamilyRow) => [
  row.family,
  `${row.passed}/${row.scenarios - row.todo}`,
  row.todo ? String(row.todo) : '-',
  String(row.obsolete_fact_used),
  String(row.unsupported_claim),
  String(row.needless_question),
  row.correction_to_serving_ms === null ? '-' : `${row.correction_to_serving_ms}`,
  `${row.recall_p50_ms}`,
  `${row.recall_p95_ms}`,
];
const HEADINGS = [
  'family',
  'passed',
  'todo',
  'obsolete',
  'unsupported',
  'question',
  'correction ms',
  'recall p50',
  'recall p95',
];

export function renderTable(rows: readonly FamilyRow[]): string[] {
  const body = rows.map(cells);
  const widths = HEADINGS.map((heading, column) =>
    Math.max(heading.length, ...body.map((row) => (row[column] ?? '').length)),
  );
  const line = (values: readonly string[]) =>
    values.map((value, column) => value.padEnd(widths[column] ?? 0)).join('  ');
  return [line(HEADINGS), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)];
}

/** The counterfactual arm: a `memory_required` scenario must not pass without memory. */
export function notExercised(runs: readonly ScenarioRun[]): string[] {
  return runs
    .filter((run) => run.arm === 'withheld' && run.outcome === 'passed')
    .map((run) => run.id);
}

async function main() {
  const scenarios = await loadScenarios();
  out('Melete memory conformance');
  out('=========================');
  out();
  for (const scenario of scenarios) {
    const needs = scenario.memory_required ? 'memory required' : 'memory optional';
    out(`${scenario.family}/${scenario.id}${scenario.status === 'todo' ? ' (todo)' : ''}`);
    out(`   ${scenario.narrative}`);
    out(`   ${scenario.steps.length} steps, ${needs}`);
    if (scenario.todo_reason) out(`   todo: ${scenario.todo_reason}`);
  }
  out();

  const harness: Harness = await openHarness();
  if (!harness) {
    out('db tests skipped: set DATABASE_URL to run them against a real Postgres');
    out('A skip is not evidence that the memory scenarios passed.');
    return 0;
  }
  const runs: ScenarioRun[] = [];
  try {
    for (const scenario of scenarios) {
      const result = await harness.run(scenario, 'memory');
      runs.push(result);
      out(
        `${result.outcome.padEnd(6)} ${scenario.family}/${scenario.id} (${result.duration_ms} ms)`,
      );
      for (const failure of result.failures) out(`       ${failure}`);
      if (scenario.status === 'todo' || !scenario.memory_required) continue;
      const withheld = await harness.run(scenario, 'withheld');
      runs.push(withheld);
      if (withheld.outcome === 'passed')
        out(`       memory not exercised: it passes with recall withheld`);
    }
  } finally {
    await harness.close();
  }

  out();
  for (const line of renderTable(familyRows(runs))) out(line);
  out();

  const stranded = notExercised(runs);
  const failed = runs.filter((run) => run.arm === 'memory' && run.outcome === 'failed');
  const report = {
    generated_at: new Date().toISOString(),
    database: process.env.DATABASE_URL ? 'external' : 'embedded',
    scenarios: runs.map((run) => ({
      id: run.id,
      family: run.family,
      title: run.title,
      arm: run.arm,
      outcome: run.outcome,
      memory_required: run.memory_required,
      duration_ms: run.duration_ms,
      failures: run.failures,
      metrics: {
        ...run.metrics,
        recall_p50_ms: p50(run.metrics.recall_ms),
        recall_p95_ms: p95(run.metrics.recall_ms),
      },
    })),
    families: familyRows(runs),
    counterfactual: {
      checked: runs.filter((run) => run.arm === 'withheld').length,
      memory_not_exercised: stranded,
    },
    ok: failed.length === 0 && stranded.length === 0,
  };
  await mkdir(here, { recursive: true });
  await writeFile(`${here}report.json`, `${JSON.stringify(report, null, 2)}\n`);
  out(`report written to conformance/memory/report.json`);
  if (stranded.length) {
    out(`memory not exercised: ${stranded.join(', ')}`);
    return 1;
  }
  if (failed.length) {
    out(`failed: ${failed.map((run) => run.id).join(', ')}`);
    return 1;
  }
  const deferred = runs.filter((run) => run.arm === 'memory' && run.outcome === 'todo').length;
  out(
    `All ${runs.filter((run) => run.arm === 'memory' && run.outcome === 'passed').length} active memory scenarios passed; ` +
      `${deferred} deferred. ${report.counterfactual.checked} counterfactual checks exercised memory.`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
