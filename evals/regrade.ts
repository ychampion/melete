/**
 * Re-score a recorded campaign artifact with the current deterministic grader.
 *
 * Every recorded cell keeps the evidence its grade was computed from, so a
 * change to the grader can be measured against the same replies and effects
 * without a model, a stack or a provider key. Nothing here opens a socket, and
 * the recorded artifact is only ever read: the language rubric is carried over
 * as recorded, and a cell that was not run stays not run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type GradeContext, grade } from './grading.ts';
import { type CellResult, type Check, type Scenario, SUITES, type Suite } from './types.ts';

export type RegradedCell = {
  run: number;
  id: string;
  suite: Suite;
  recorded: CellResult['status'];
  regraded: CellResult['status'];
  /** Checks whose verdict differs from the recorded one, by name. */
  changed: { name: string; recorded: boolean | null; regraded: boolean | null }[];
};
export type SuiteCount = { suite: Suite; cells: number; recorded: number; regraded: number };
export type Regrade = {
  cells: RegradedCell[];
  suites: SuiteCount[];
  total: { cells: number; recorded: number; regraded: number };
  /** How many cells changed verdict on a check both graders ran, in each direction. */
  checks: { name: string; now_pass: number; now_fail: number }[];
  /** Checks the recorded cells never ran, and how many cells fail each now. */
  added: { name: string; cells: number; failing: number }[];
};

/** Checks named after a value or an id are counted together, under their common words. */
const CHECK_FAMILIES = [
  'reply contains',
  'reply excludes obsolete or unchanged value',
  'approved payload and revision match delivery',
];

const observed = (evidence: unknown): evidence is GradeContext =>
  !!evidence &&
  typeof evidence === 'object' &&
  'initial' in evidence &&
  'final' in evidence &&
  !!evidence.initial &&
  !!evidence.final;

export function regrade(results: readonly CellResult[], scenarios: readonly Scenario[]): Regrade {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const cells: RegradedCell[] = [];
  for (const result of results) {
    const scenario = byId.get(result.id);
    if (!scenario) throw new Error(`The artifact names a scenario the corpus lacks: ${result.id}`);
    if (result.status === 'not_run' || !observed(result.evidence)) {
      cells.push({
        run: result.run,
        id: result.id,
        suite: result.suite,
        recorded: result.status,
        regraded: result.status,
        changed: [],
      });
      continue;
    }
    const outcome = grade(scenario, result.evidence);
    const before = new Map(result.checks.map((check: Check) => [check.name, check.pass]));
    const after = new Map(outcome.checks.map((check) => [check.name, check.pass]));
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((name) => before.get(name) !== after.get(name))
      .map((name) => ({
        name,
        recorded: before.get(name) ?? null,
        regraded: after.get(name) ?? null,
      }));
    cells.push({
      run: result.run,
      id: result.id,
      suite: result.suite,
      recorded: result.status,
      regraded: outcome.ran ? (outcome.passed ? 'passed' : 'failed') : 'not_run',
      changed,
    });
  }
  const count = (rows: RegradedCell[]) => ({
    cells: rows.length,
    recorded: rows.filter((row) => row.recorded === 'passed').length,
    regraded: rows.filter((row) => row.regraded === 'passed').length,
  });
  const flips = new Map<string, { now_pass: number; now_fail: number }>();
  const added = new Map<string, { cells: number; failing: number }>();
  for (const cell of cells)
    for (const change of cell.changed) {
      const name = CHECK_FAMILIES.find((family) => change.name.startsWith(family)) ?? change.name;
      if (change.recorded === null) {
        const entry = added.get(name) ?? { cells: 0, failing: 0 };
        entry.cells++;
        if (change.regraded === false) entry.failing++;
        added.set(name, entry);
        continue;
      }
      if (change.regraded === null) continue;
      const entry = flips.get(name) ?? { now_pass: 0, now_fail: 0 };
      if (change.regraded) entry.now_pass++;
      else entry.now_fail++;
      flips.set(name, entry);
    }
  return {
    cells,
    suites: SUITES.map((suite) => ({
      suite,
      ...count(cells.filter((cell) => cell.suite === suite)),
    })).filter((row) => row.cells > 0),
    total: count(cells),
    checks: [...flips.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    added: [...added.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function renderRegrade(result: Regrade): string {
  const lines = [
    '| Suite | Cells | Recorded deterministic passes | Regraded deterministic passes |',
    '|---|---|---|---|',
    ...result.suites.map(
      (row) => `| ${row.suite} | ${row.cells} | ${row.recorded} | ${row.regraded} |`,
    ),
    `| all | ${result.total.cells} | ${result.total.recorded} | ${result.total.regraded} |`,
  ];
  if (result.checks.length)
    lines.push(
      '',
      '| Check whose verdict changed | Cells now passing | Cells now failing |',
      '|---|---|---|',
      ...result.checks.map((row) => `| ${row.name} | ${row.now_pass} | ${row.now_fail} |`),
    );
  if (result.added.length)
    lines.push(
      '',
      '| Check the recorded grader did not run | Cells it now runs on | Cells failing it |',
      '|---|---|---|',
      ...result.added.map((row) => `| ${row.name} | ${row.cells} | ${row.failing} |`),
    );
  return lines.join('\n');
}

export async function loadCorpus(): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  for await (const file of new Bun.Glob('*.json').scan(resolve(import.meta.dir, 'fixtures')))
    scenarios.push(
      JSON.parse(await readFile(resolve(import.meta.dir, 'fixtures', file), 'utf8')) as Scenario,
    );
  return scenarios;
}

/** `bun run evals/regrade.ts <artifact.json> [--out <report.json>]`. */
export async function main(args: readonly string[]): Promise<number> {
  const parsed = parseArgs({
    args: args.filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  const [input] = parsed.positionals;
  const out = parsed.values.out;
  if (!input || parsed.positionals.length !== 1) {
    console.error('Usage: bun run evals/regrade.ts <artifact.json> [--out <report.json>]');
    return 2;
  }
  if (out && resolve(out) === resolve(input)) {
    console.error('The regrade report cannot replace the recorded artifact.');
    return 2;
  }
  const artifact = JSON.parse(await readFile(resolve(input), 'utf8')) as {
    results?: CellResult[];
  };
  if (!Array.isArray(artifact.results)) {
    console.error('The artifact has no results array.');
    return 2;
  }
  const result = regrade(artifact.results, await loadCorpus());
  console.log(renderRegrade(result));
  if (out) await writeFile(resolve(out), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
