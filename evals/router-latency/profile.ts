/** Read-only aggregation. No service configuration, database access, or network requests. */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const string = (value: unknown, fallback = 'unknown'): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

export function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (percentile === 0.5) {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? (sorted[middle] ?? null)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

export function profileResults(
  inputs: { name: string; data: unknown }[],
  taskMap: Record<string, string> = {},
) {
  const runs = inputs.map(({ name, data }) => {
    const envelope = object(data);
    const label = string(envelope.label, name);
    const model = object(envelope.model);
    const requestedModel =
      typeof envelope.model === 'string'
        ? envelope.model
        : model.provider && model.model
          ? `${model.provider}/${model.model}`
          : 'unknown';
    // Older result envelopes only encoded the build in their label; never infer it from a date.
    const inferredBuild = label
      .split('-')
      .find((part) => /^[a-f\d]{7,40}$/i.test(part) && !/^\d{8}$/.test(part));
    const build = string(envelope.build, inferredBuild);
    const guidance = string(envelope.guidance, label.match(/(?:^|-)g(on|off)(?:-|$)/)?.[1]);
    const rows = Array.isArray(data) ? data : envelope.results;
    if (!Array.isArray(rows))
      throw new Error(`${name}: expected an envelope with results or a partial result array`);
    return {
      name,
      build,
      requestedModel,
      guidance,
      partial: Array.isArray(data),
      recordedRunCostUsd: number(envelope.spent_usd),
      rows,
    };
  });
  const attempts = runs.flatMap((run) =>
    run.rows.map((value, index) => {
      const row = object(value);
      const task = string(row.task);
      const checks = Array.isArray(row.checks) ? row.checks.map(object) : [];
      const harnessError = checks.some((c) => c.check === 'harness_error' && c.ok === false);
      const actual = Array.isArray(row.model_actual)
        ? row.model_actual.filter((m): m is string => typeof m === 'string').sort()
        : [];
      const tools = Array.isArray(row.tools)
        ? row.tools.filter((t): t is string => typeof t === 'string')
        : [];
      const toolCounts: Record<string, number> = Object.create(null);
      for (const tool of tools) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      return {
        run: run.name,
        index,
        build: run.build,
        model: actual.length ? actual.join(',') : run.requestedModel,
        guidance: run.guidance,
        task: Object.hasOwn(taskMap, task) ? (taskMap[task] ?? task) : task,
        outcome: harnessError
          ? 'harness_error'
          : row.pass === true
            ? 'success'
            : row.pass === false
              ? 'failure'
              : 'unknown',
        wallSeconds: number(row.wall_s),
        modelCalls: number(row.model_calls),
        toolCalls: number(row.tool_calls) ?? (Array.isArray(row.tools) ? tools.length : null),
        recordedCostUsd: number(row.cost_usd),
        toolCounts,
      };
    }),
  );
  const buckets = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    for (const task of [attempt.task, null]) {
      const key = JSON.stringify([attempt.build, attempt.model, attempt.guidance, task]);
      const rows = buckets.get(key) ?? [];
      rows.push(attempt);
      buckets.set(key, rows);
    }
  }
  const groups = [...buckets].map(([key, rows]) => {
    const [build, model, guidance, task] = JSON.parse(key) as [
      string,
      string,
      string,
      string | null,
    ];
    const durations = rows.flatMap((r) => (r.wallSeconds === null ? [] : [r.wallSeconds]));
    const sum = (field: 'modelCalls' | 'toolCalls' | 'recordedCostUsd') => {
      const recorded = rows.flatMap((r) => (r[field] === null ? [] : [r[field]]));
      return recorded.length ? recorded.reduce((a, b) => a + b, 0) : null;
    };
    const toolCounts: Record<string, number> = Object.create(null);
    for (const row of rows)
      for (const [tool, count] of Object.entries(row.toolCounts))
        toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    return {
      build,
      model,
      guidance,
      task,
      attempts: rows.length,
      successes: rows.filter((r) => r.outcome === 'success').length,
      failures: rows.filter((r) => r.outcome === 'failure').length,
      harnessErrors: rows.filter((r) => r.outcome === 'harness_error').length,
      unknownOutcomes: rows.filter((r) => r.outcome === 'unknown').length,
      timed: durations.length,
      missingDuration: rows.length - durations.length,
      medianSeconds: quantile(durations, 0.5),
      p95Seconds: quantile(durations, 0.95),
      modelCalls: sum('modelCalls'),
      toolCalls: sum('toolCalls'),
      recordedCostUsd: sum('recordedCostUsd'),
      missingModelCalls: rows.filter((r) => r.modelCalls === null).length,
      missingToolCalls: rows.filter((r) => r.toolCalls === null).length,
      missingCost: rows.filter((r) => r.recordedCostUsd === null).length,
      toolCounts,
    };
  });
  return {
    version: 1,
    runs: runs.map(({ rows, ...run }) => ({ ...run, attempts: rows.length })),
    groups,
    attempts,
    limitations: [
      'Wall time includes harness observation and any human waiting; stage times cannot be reconstructed from aggregates.',
      'Repeated tool names count invocations, not proven duplicate arguments.',
      'Recorded row costs and run totals have different scopes; missing cost is unknown, not zero.',
    ],
  };
}

export const STAGES = [
  'ingress_accepted',
  'attempt_started',
  'first_model_call',
  'freebusy_completed',
  'question_available',
  'answer_accepted',
  'approval_available',
  'approval_decided',
  'resumed_attempt',
  'write_completed',
  'verification_completed',
  'board_update_observed',
] as const;
type Observation = {
  stage: (typeof STAGES)[number];
  at: string | null;
  observedAt?: string | null;
  source: string;
  jobId?: string;
  attemptId?: string;
  callId?: string;
  actionId?: string;
};
type Interval = {
  kind: 'model' | 'machine' | 'human' | 'harness';
  start: string | null;
  end: string | null;
  source: string;
  jobId?: string;
  attemptId?: string;
  callId?: string;
  actionId?: string;
};
type Trace = {
  version: 1;
  observations: Observation[];
  intervals?: Interval[];
  receipts?: { callId: string; latencyMs: number | null }[];
};
function instant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('Trace timestamps must be ISO instants with an offset, or null');
  return Date.parse(value);
}
function union(intervals: [number, number][]): number | null {
  if (!intervals.length) return null;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let end = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (const [start, finish] of sorted) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
}
export function analyzeTrace(trace: Trace) {
  if (trace.version !== 1 || !Array.isArray(trace.observations))
    throw new Error('Expected trace version 1 with observations');
  const timeline = trace.observations.map((o) => {
    if (!STAGES.includes(o.stage) || !o.source)
      throw new Error('Each observation needs a known stage and source');
    const at = instant(o.at);
    const observed = instant(o.observedAt);
    return {
      ...o,
      at: o.at ?? null,
      observationLagMs: at !== null && observed !== null ? observed - at : null,
    };
  });
  const intervals = (trace.intervals ?? []).map((i) => {
    if (!['model', 'machine', 'human', 'harness'].includes(i.kind) || !i.source)
      throw new Error('Invalid interval kind or source');
    const start = instant(i.start);
    const end = instant(i.end);
    if (start !== null && end !== null && end < start)
      throw new Error('Interval ends before it starts');
    return {
      ...i,
      times: start !== null && end !== null ? ([start, end] as [number, number]) : null,
    };
  });
  const times = (kinds: Interval['kind'][]) =>
    intervals.flatMap((i) => (kinds.includes(i.kind) && i.times ? [i.times] : []));
  const completeUnion = (kinds: Interval['kind'][]) =>
    intervals.some((i) => kinds.includes(i.kind) && !i.times) ? null : union(times(kinds));
  const model = times(['model']);
  const modelMs = union(model);
  return {
    timeline,
    intervals: intervals.map(({ times: _times, ...i }) => i),
    modelMs: completeUnion(['model']),
    activeMachineMs: completeUnion(['machine', 'model']),
    humanWaitMs: completeUnion(['human']),
    harnessWaitMs: completeUnion(['harness']),
    knownIntervalUnionsMs: {
      model: modelMs,
      activeMachine: union(times(['machine', 'model'])),
      human: union(times(['human'])),
      harness: union(times(['harness'])),
    },
    missingIntervals: intervals.filter((i) => !i.times).length,
    overlappingModelIntervals:
      modelMs !== null && model.reduce((sum, [start, end]) => sum + end - start, 0) > modelMs,
    receipts: trace.receipts ?? [],
    missingStages: STAGES.filter((s) => !timeline.some((o) => o.stage === s && o.at !== null)),
    limitations: [
      'Intervals are elapsed unions across the exported trace, not summed concurrent work.',
      'Absent intervals remain unknown. Receipt latencyMs is per call; it does not establish start/end times.',
      'Observation timestamps never substitute for product timestamps. Negative observation lag indicates clock skew.',
    ],
  };
}

async function resultFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [resolve(path)];
  const entries = await readdir(path, { withFileTypes: true });
  // Only results.json files; do not ingest profiles, configs, or other neighboring artifacts.
  const files: string[] = entries.some((e) => e.isFile() && e.name === 'results.json')
    ? [resolve(path, 'results.json')]
    : [];
  for (const entry of entries)
    if (entry.isDirectory()) files.push(...(await resultFiles(join(path, entry.name))));
  return files;
}
export async function main(args: string[]) {
  const paths: string[] = [];
  const traces: string[] = [];
  let out: string | undefined;
  let mapping: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') {
      process.stdout.write(
        'profile.ts [--results DIR]... [--results-root DIR] [--task-map JSON] [--trace JSON]... [--out JSON]\n',
      );
      return;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--results' || flag === '--results-root') paths.push(value);
    else if (flag === '--trace') traces.push(value);
    else if (flag === '--task-map') mapping = value;
    else if (flag === '--out') out = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!paths.length && !traces.length) throw new Error('Supply results or a trace');
  const files = [...new Set((await Promise.all(paths.map(resultFiles))).flat())].sort();
  const taskMap: unknown = mapping ? JSON.parse(await readFile(mapping, 'utf8')) : {};
  if (
    Array.isArray(taskMap) ||
    taskMap === null ||
    typeof taskMap !== 'object' ||
    Object.values(taskMap).some((v) => typeof v !== 'string')
  )
    throw new Error('Task mapping must be a JSON object of names to labels');
  const result = {
    ...profileResults(
      await Promise.all(
        files.map(async (path) => ({
          name: basename(join(path, '..')),
          data: JSON.parse(await readFile(path, 'utf8')),
        })),
      ),
      taskMap as Record<string, string>,
    ),
    traces: await Promise.all(
      traces.map(async (path) => analyzeTrace(JSON.parse(await readFile(path, 'utf8')))),
    ),
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (out) await writeFile(out, json);
  else process.stdout.write(json);
}
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
