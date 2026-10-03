/**
 * Pass rates per scenario and per model, cost and latency, and the comparison
 * against a stored baseline that lets a run gate a release.
 *
 *   bun run evals/summary.ts evals/results/a.json evals/results/b.json
 *   bun run evals/summary.ts <artifacts...> --baseline evals/baselines/fireworks.json
 *   bun run evals/summary.ts <artifacts...> --write-baseline evals/baselines/fireworks.json
 *
 * A baseline stores pass rates only, never replies or evidence. A key scenario
 * regresses when its pass rate falls more than the threshold below the
 * baseline's; a skipped scenario, or one the run did not select, is reported
 * and not compared.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { CellResult, Scenario } from './types.ts';

export type ScenarioSummary = {
  id: string;
  suite: string;
  cells: number;
  passed: number;
  failed: number;
  not_run: number;
  skipped: number;
  /** Passes over cells that were not skipped; a cell that did not complete counts against it. */
  pass_rate: number | null;
  rubric_passed: number;
  rubric_judged: number;
  median_ms: number | null;
  cost_usd: number;
  skip_reason?: string;
};
export type Summary = {
  campaign: string;
  provider: string;
  model: string;
  engine: string;
  runs: number;
  scenarios: ScenarioSummary[];
  suites: { suite: string; cells: number; passed: number; pass_rate: number | null }[];
  total: {
    cells: number;
    passed: number;
    skipped: number;
    not_run: number;
    pass_rate: number | null;
    cost_usd: number;
    median_ms: number | null;
    p90_ms: number | null;
  };
};
export type Baseline = {
  description?: string;
  /** Largest allowed drop in a key scenario's pass rate, from 0 to 1. */
  threshold: number;
  key_scenarios: string[];
  /** Pass rates by model id, then by scenario id. */
  models: Record<string, { engine?: string; runs?: number; scenarios: Record<string, number> }>;
};
export type Comparison = {
  threshold: number;
  rows: {
    id: string;
    baseline: number;
    current: number | null;
    status: 'ok' | 'regressed' | 'improved' | 'skipped' | 'not_selected';
  }[];
  regressions: string[];
};

const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
};
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return ((sorted[middle] ?? 0) + (sorted[sorted.length - 1 - middle] ?? 0)) / 2;
};
const rateOf = (passed: number, denominator: number) => (denominator ? passed / denominator : null);

export function summarize(
  meta: { campaign: string; provider: string; model: string; engine: string; runs: number },
  results: readonly CellResult[],
  scenarios: readonly Pick<Scenario, 'id' | 'suite'>[],
): Summary {
  const rows: ScenarioSummary[] = scenarios.map((scenario) => {
    const cells = results.filter((result) => result.id === scenario.id);
    const count = (status: CellResult['status']) =>
      cells.filter((cell) => cell.status === status).length;
    const skipped = count('skipped');
    const ran = cells.filter((cell) => cell.status === 'passed' || cell.status === 'failed');
    const judged = cells.filter((cell) => cell.rubric.status !== 'not_run');
    const reason = cells.find((cell) => cell.status === 'skipped')?.finding ?? undefined;
    return {
      id: scenario.id,
      suite: scenario.suite,
      cells: cells.length,
      passed: count('passed'),
      failed: count('failed'),
      not_run: count('not_run'),
      skipped,
      pass_rate: rateOf(count('passed'), cells.length - skipped),
      rubric_passed: judged.filter((cell) => cell.rubric.status === 'passed').length,
      rubric_judged: judged.length,
      median_ms: median(ran.map((cell) => cell.duration_ms)),
      cost_usd: cells.reduce((sum, cell) => sum + cell.cost_usd, 0),
      ...(reason ? { skip_reason: reason } : {}),
    };
  });
  const suites = [...new Set(rows.map((row) => row.suite))].map((suite) => {
    const members = rows.filter((row) => row.suite === suite);
    const cells = members.reduce((sum, row) => sum + row.cells - row.skipped, 0);
    const passed = members.reduce((sum, row) => sum + row.passed, 0);
    return { suite, cells, passed, pass_rate: rateOf(passed, cells) };
  });
  const ran = results.filter((cell) => cell.status === 'passed' || cell.status === 'failed');
  const skipped = results.filter((cell) => cell.status === 'skipped').length;
  const passed = results.filter((cell) => cell.status === 'passed').length;
  return {
    ...meta,
    scenarios: rows,
    suites,
    total: {
      cells: results.length,
      passed,
      skipped,
      not_run: results.filter((cell) => cell.status === 'not_run').length,
      pass_rate: rateOf(passed, results.length - skipped),
      cost_usd: results.reduce((sum, cell) => sum + cell.cost_usd, 0),
      median_ms: median(ran.map((cell) => cell.duration_ms)),
      p90_ms: quantile(
        ran.map((cell) => cell.duration_ms),
        0.9,
      ),
    },
  };
}

export function compare(summary: Summary, baseline: Baseline, threshold = baseline.threshold) {
  const recorded = baseline.models[summary.model]?.scenarios ?? {};
  const comparison: Comparison = { threshold, rows: [], regressions: [] };
  for (const id of baseline.key_scenarios) {
    const expected = recorded[id];
    if (expected === undefined) continue;
    const row = summary.scenarios.find((entry) => entry.id === id);
    let status: Comparison['rows'][number]['status'];
    if (!row || row.cells === 0) status = 'not_selected';
    else if (row.pass_rate === null) status = 'skipped';
    else if (row.pass_rate < expected - threshold - 1e-9) status = 'regressed';
    else if (row.pass_rate > expected + 1e-9) status = 'improved';
    else status = 'ok';
    comparison.rows.push({ id, baseline: expected, current: row?.pass_rate ?? null, status });
    if (status === 'regressed') comparison.regressions.push(id);
  }
  return comparison;
}

const percent = (value: number | null) =>
  value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`;
const seconds = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const dollars = (value: number) => `$${value.toFixed(4)}`;

export function renderSummary(summary: Summary, comparison?: Comparison): string {
  const lines = [
    `## ${summary.model} (${summary.engine} engine, ${summary.runs} run${summary.runs === 1 ? '' : 's'})`,
    '',
    `Deterministic pass rate ${percent(summary.total.pass_rate)} (${summary.total.passed}/${summary.total.cells - summary.total.skipped}; ${summary.total.skipped} skipped, ${summary.total.not_run} not run). Cost ${dollars(summary.total.cost_usd)}. Median cell ${seconds(summary.total.median_ms)}, 90th percentile ${seconds(summary.total.p90_ms)}.`,
    '',
    '| Scenario | Suite | Passed | Pass rate | Rubric | Median time | Cost |',
    '|---|---|---|---|---|---|---|',
    ...summary.scenarios.map(
      (row) =>
        `| ${row.id} | ${row.suite} | ${row.skipped === row.cells && row.cells ? `skipped: ${row.skip_reason ?? ''}` : `${row.passed}/${row.cells - row.skipped}`} | ${percent(row.pass_rate)} | ${row.rubric_judged ? `${row.rubric_passed}/${row.rubric_judged}` : 'not run'} | ${seconds(row.median_ms)} | ${dollars(row.cost_usd)} |`,
    ),
  ];
  if (comparison) {
    lines.push(
      '',
      `Baseline comparison (a key scenario regresses when it drops more than ${percent(comparison.threshold)}):`,
      '',
      '| Key scenario | Baseline | Now | Status |',
      '|---|---|---|---|',
      ...comparison.rows.map(
        (row) =>
          `| ${row.id} | ${percent(row.baseline)} | ${percent(row.current)} | ${row.status} |`,
      ),
      '',
      comparison.regressions.length
        ? `Regressed: ${comparison.regressions.join(', ')}.`
        : 'No key scenario regressed.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One row per scenario, one column per model. */
export function renderModels(summaries: readonly Summary[]): string {
  const ids = [...new Set(summaries.flatMap((summary) => summary.scenarios.map((row) => row.id)))];
  const header = `| Scenario | ${summaries.map((summary) => summary.model.split('/').at(-1)).join(' | ')} |`;
  const cell = (summary: Summary, id: string) => {
    const row = summary.scenarios.find((entry) => entry.id === id);
    if (!row?.cells) return '';
    if (row.skipped === row.cells) return 'skipped';
    return `${row.passed}/${row.cells - row.skipped}`;
  };
  return [
    header,
    `|---|${summaries.map(() => '---').join('|')}|`,
    ...ids.map((id) => `| ${id} | ${summaries.map((summary) => cell(summary, id)).join(' | ')} |`),
    `| **Pass rate** | ${summaries.map((summary) => `**${percent(summary.total.pass_rate)}**`).join(' | ')} |`,
    `| Cost | ${summaries.map((summary) => dollars(summary.total.cost_usd)).join(' | ')} |`,
    `| Median cell time | ${summaries.map((summary) => seconds(summary.total.median_ms)).join(' | ')} |`,
  ].join('\n');
}

export function baselineFrom(
  summaries: readonly Summary[],
  keyScenarios: readonly string[],
  threshold: number,
  description?: string,
): Baseline {
  return {
    ...(description ? { description } : {}),
    threshold,
    key_scenarios: [...keyScenarios],
    models: Object.fromEntries(
      summaries.map((summary) => [
        summary.model,
        {
          engine: summary.engine,
          runs: summary.runs,
          scenarios: Object.fromEntries(
            summary.scenarios.flatMap((row) =>
              row.pass_rate === null ? [] : [[row.id, Math.round(row.pass_rate * 1000) / 1000]],
            ),
          ),
        },
      ]),
    ),
  };
}

type Artifact = {
  metadata: {
    campaign: string;
    provider_actual: string;
    model_actual: string;
    engine?: string;
    runs: number;
  };
  scenarios?: Pick<Scenario, 'id' | 'suite'>[];
  results: CellResult[];
};
export function summaryOfArtifact(artifact: Artifact): Summary {
  const scenarios = artifact.scenarios ?? [
    ...new Map(
      artifact.results.map((cell) => [cell.id, { id: cell.id, suite: cell.suite }]),
    ).values(),
  ];
  return summarize(
    {
      campaign: artifact.metadata.campaign,
      provider: artifact.metadata.provider_actual,
      model: artifact.metadata.model_actual,
      engine: artifact.metadata.engine ?? 'hermes',
      runs: artifact.metadata.runs,
    },
    artifact.results,
    scenarios,
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      baseline: { type: 'string' },
      'write-baseline': { type: 'string' },
      threshold: { type: 'string' },
      key: { type: 'string' },
    },
  });
  if (!positionals.length) throw new Error('Name one or more result artifacts');
  const summaries = await Promise.all(
    positionals.map(async (path) =>
      summaryOfArtifact(JSON.parse(await readFile(path, 'utf8')) as Artifact),
    ),
  );
  console.log(renderModels(summaries));
  let regressed = false;
  if (values.baseline) {
    const baseline = JSON.parse(await readFile(values.baseline, 'utf8')) as Baseline;
    for (const summary of summaries) {
      const comparison = compare(
        summary,
        baseline,
        values.threshold ? Number(values.threshold) : undefined,
      );
      console.log(`\n${renderSummary(summary, comparison)}`);
      regressed ||= comparison.regressions.length > 0;
    }
  }
  if (values['write-baseline']) {
    const keys = values.key
      ? values.key.split(',')
      : [...new Set(summaries.flatMap((summary) => summary.scenarios.map((row) => row.id)))];
    await writeFile(
      values['write-baseline'],
      `${JSON.stringify(baselineFrom(summaries, keys, values.threshold ? Number(values.threshold) : 0.34), null, 2)}\n`,
    );
  }
  if (regressed) process.exitCode = 1;
}
