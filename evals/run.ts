import { closeSync, openSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { IDENTITY, IDENTITY_TOKENS } from '../packages/runtime-hermes/src/instructions.ts';
import { grade, rubricGrade } from './grading.ts';
import { openLab } from './lab.ts';
import { type Metadata, writeReport } from './report.ts';
import { command, openStack, PRIVATE, ROOT } from './stack.ts';
import { BudgetExceeded, MODEL, State, sha256 } from './state.ts';
import { type CellResult, type Scenario, SUITES } from './types.ts';

const options = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  strict: true,
  options: {
    provider: { type: 'string', default: 'fireworks' },
    model: { type: 'string', default: MODEL },
    suite: { type: 'string', default: 'all' },
    runs: { type: 'string', default: '3' },
    workers: { type: 'string', default: '3' },
    seed: { type: 'string', default: '20260912' },
    campaign: { type: 'string', default: 'fireworks-evals' },
    budget: { type: 'string', default: '50' },
    limit: { type: 'string' },
    case: { type: 'string' },
    gate: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    regrade: { type: 'string' },
    out: { type: 'string' },
  },
}).values;
// Re-scoring a recorded artifact needs no lock, stack, journal or provider key,
// and makes no model call: it ends here, before any of them is touched.
if (options.regrade) {
  const { main } = await import('./regrade.ts');
  process.exit(await main([options.regrade, ...(options.out ? ['--out', options.out] : [])]));
}
const integer = (value: string, name: string, max: number) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`Invalid ${name}`);
  return number;
};
const runs = integer(options.runs, 'runs', 10);
const workerCount = integer(options.workers, 'workers', 3);
const seed = integer(options.seed, 'seed', 2147483647);
const requested = options.provider;
if (requested !== 'fireworks' && requested !== 'scripted')
  throw new Error('Choose fireworks or scripted');
if (requested === 'fireworks' && options.model !== MODEL)
  throw new Error('This campaign only prices accounts/fireworks/models/deepseek-v4p1-flash');
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.campaign))
  throw new Error('Campaign must contain only lowercase letters, digits, and hyphens');
if (options.suite !== 'all' && !SUITES.includes(options.suite as (typeof SUITES)[number]))
  throw new Error('Unknown suite');
const allScenarios: Scenario[] = [];
for await (const file of new Bun.Glob('*.json').scan(resolve(import.meta.dir, 'fixtures'))) {
  const value = JSON.parse(
    await readFile(resolve(import.meta.dir, 'fixtures', file), 'utf8'),
  ) as Scenario;
  if (
    !value.id ||
    !SUITES.includes(value.suite) ||
    !value.script ||
    !value.rubric ||
    !value.expectation
  )
    throw new Error(`Invalid fixture: ${file}`);
  allScenarios.push(value);
}
allScenarios.sort((a, b) => a.id.localeCompare(b.id));
if (
  allScenarios.length < 60 ||
  new Set(allScenarios.map((scenario) => scenario.id)).size !== allScenarios.length
)
  throw new Error('Corpus must contain at least 60 unique scenarios');
let scenarios = allScenarios.filter(
  (scenario) =>
    (options.suite === 'all' || scenario.suite === options.suite) &&
    (!options.case || scenario.id === options.case),
);
if (options.limit)
  scenarios = scenarios.slice(0, integer(options.limit, 'limit', allScenarios.length));
if (!scenarios.length) throw new Error('No scenarios selected');
if (options.list) {
  for (const scenario of scenarios)
    console.log(`${scenario.id}\t${scenario.domain}\t${scenario.title}`);
  process.exit(0);
}
await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
const lockPath = resolve(PRIVATE, 'runner.lock');
async function lock() {
  try {
    const descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1)
      throw new Error('Invalid evaluation lock; inspect it before continuing');
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH'))
        throw failure;
      await rename(lockPath, `${lockPath}.stale-${pid}`);
      return lock();
    }
    throw new Error('Another evaluation runner owns this checkout');
  }
}
await lock();
const state = new State(resolve(PRIVATE, 'evals.sqlite'), Number(options.budget));
const key = requested === 'fireworks' ? process.env.FIREWORKS_API_KEY : undefined;
const provider = requested === 'fireworks' && key ? 'fireworks' : 'scripted';
const model = provider === 'fireworks' ? MODEL : 'scripted';
const prefix = `${options.campaign}:`;
function safeError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  if (key) message = message.replaceAll(key, '[redacted]');
  return message
    .replaceAll(ROOT, '[checkout]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database]')
    .replace(/(?:Bearer\s+|fw_)[A-Za-z0-9_.-]+/g, '[redacted]')
    .slice(0, 1200);
}
const fingerprintInputs: string[] = [];
for (const pattern of [
  'apps/melete/src/**/*.ts',
  'apps/melete/drizzle/*.sql',
  'apps/melete/package.json',
  'packages/runtime-hermes/package.json',
  'packages/runtime-hermes/Dockerfile',
  'packages/contracts/src/**/*.ts',
  'packages/runtime-hermes/src/**/*.ts',
  'packages/runtime-hermes/melete_plugin/*.py',
  'packages/runtime-hermes/config/*.yaml',
  'evals/*.ts',
  'evals/fixtures/*.json',
  'evals/compose.yml',
  'evals/Dockerfile',
  'packages/runtime-hermes/patches/*.py',
  'packages/runtime-hermes/runtime_support/*.py',
  'packages/runtime-hermes/entrypoint.sh',
  'bun.lock',
  'package.json',
]) {
  for await (const path of new Bun.Glob(pattern).scan(ROOT)) fingerprintInputs.push(path);
}
const fingerprint = sha256(
  (
    await Promise.all(
      [...new Set(fingerprintInputs)]
        .sort()
        .map(async (path) => `${path}\n${await readFile(resolve(ROOT, path), 'utf8')}`),
    )
  ).join('\n'),
);
const meta: Metadata = {
  campaign: options.campaign,
  provider_requested: requested,
  provider_actual: provider,
  model_requested: requested === 'scripted' ? 'scripted' : options.model,
  model_actual: model,
  source_hash: fingerprint,
  identity_hash: sha256(IDENTITY),
  base_commit: await command(['git', 'merge-base', 'HEAD', 'origin/integration']),
  runs,
  seed,
  command: `bun run evals -- --provider ${requested} --model ${requested === 'scripted' ? 'scripted' : options.model} --suite ${options.suite} --runs ${runs} --seed ${seed} --campaign ${options.campaign} --budget ${options.budget} --workers ${workerCount}${options.case ? ` --case ${options.case}` : ''}${options.limit ? ` --limit ${options.limit}` : ''}${options.gate ? ' --gate' : ''}`,
  total_cost_usd: state.used(),
  limitation:
    provider === 'scripted'
      ? 'Fireworks agent inference and model-based rubric grading were not run. These are scripted-provider boundary checks, not evidence of real-model performance.'
      : null,
};
const labs: Awaited<ReturnType<typeof openLab>>[] = [];
const workerStates: State[] = [];
let interrupted = false;
const results = () => state.results(prefix);
let reportChain = Promise.resolve();
const report = () => {
  reportChain = reportChain.then(async () => {
    meta.total_cost_usd = state.used();
    await writeReport(meta, results(), scenarios);
  });
  return reportChain;
};
function shuffle<T>(items: readonly T[], salt: number): T[] {
  const output = [...items];
  let x = salt | 0;
  for (let i = output.length - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    const a = output[i];
    const b = output[j];
    if (a !== undefined && b !== undefined) {
      output[i] = b;
      output[j] = a;
    }
  }
  return output;
}
try {
  state.pin(`${prefix}source`, fingerprint);
  state.pin(`${prefix}identity`, sha256(IDENTITY));
  state.pin(`${prefix}provider`, provider);
  state.pin(`${prefix}model`, model);
  state.pin(
    `${prefix}selection`,
    JSON.stringify({ ids: scenarios.map((scenario) => scenario.id), runs, seed }),
  );
  if (IDENTITY_TOKENS > 250) throw new Error('Identity exceeds 250 tokens');
  console.log(
    `Campaign ${options.campaign}: ${scenarios.length} scenarios x ${runs} runs; ${provider}/${model}.`,
  );
  if (meta.limitation) console.log(meta.limitation);
  const stack = await openStack();
  state.pin(`${prefix}runtime-image`, stack.imageId);
  meta.runtime_image = stack.imageId;
  const assignments = Array.from({ length: runs }, (_, i) => i + 1).flatMap((run) =>
    shuffle(scenarios, seed + run).map((scenario) => ({ run, scenario })),
  );
  for (let slot = 0; slot < Math.min(workerCount, assignments.length); slot++) {
    const workerState = new State(resolve(PRIVATE, 'evals.sqlite'), Number(options.budget));
    workerStates.push(workerState);
    labs.push(await openLab(workerState, provider, key, slot, stack));
  }
  let stopReason: string | null = null;
  let next = 0;
  await Promise.all(
    labs.map(async (lab, slot) => {
      const workerState = workerStates[slot];
      if (!workerState) throw new Error('Worker budget ledger unavailable');
      for (;;) {
        const assignment = assignments[next++];
        if (!assignment) break;
        const { run, scenario } = assignment;
        const cellKey = `${prefix}${run}:${scenario.id}`;
        const cell = state.get(cellKey);
        if (cell.result) {
          console.log(`RESUMED ${run}/${scenario.id}: ${cell.result.status}`);
          continue;
        }
        workerState.cell = cellKey;
        const started = Date.now();
        let result: CellResult;
        try {
          if (stopReason) throw new BudgetExceeded(stopReason);
          const context = await lab.run(scenario, cellKey);
          const deterministic = grade(scenario, context);
          const rubric = await rubricGrade(
            workerState,
            provider === 'fireworks' ? key : undefined,
            scenario,
            context,
          ).catch((error: unknown) => {
            const reason = safeError(error);
            if (error instanceof BudgetExceeded) stopReason = reason;
            return { status: 'not_run' as const, score: null, reason };
          });
          const cost = state.cost(cellKey);
          result = {
            run,
            id: scenario.id,
            suite: scenario.suite,
            provider,
            model,
            status: deterministic.ran ? (deterministic.passed ? 'passed' : 'failed') : 'not_run',
            checks: deterministic.checks,
            rubric,
            reply: context.final.reply,
            unnecessary_ask: deterministic.unnecessaryAsk,
            missed_ask: deterministic.missedAsk,
            duplicate_effects: deterministic.duplicateEffects,
            injection_successes: deterministic.injectionSuccesses,
            cost_usd: cost.cost,
            cost_uncertain: cost.uncertain > 0,
            duration_ms: Date.now() - started,
            finding: deterministic.passed
              ? rubric.status === 'passed'
                ? null
                : `Language rubric ${rubric.status}: ${rubric.reason}`
              : deterministic.checks
                  .filter((check) => !check.pass)
                  .map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ''}`)
                  .join('; '),
            evidence: JSON.parse(JSON.stringify(context)),
          };
        } catch (error) {
          const reason = safeError(error);
          if (error instanceof BudgetExceeded || state.used() >= state.limit) stopReason = reason;
          const cost = state.cost(cellKey);
          result = {
            run,
            id: scenario.id,
            suite: scenario.suite,
            provider,
            model,
            status: 'not_run',
            checks: [{ name: 'scenario completed', pass: false, detail: reason }],
            rubric: { status: 'not_run', score: null, reason: 'Scenario did not complete.' },
            reply: '',
            unnecessary_ask: null,
            missed_ask: null,
            duplicate_effects: null,
            injection_successes: null,
            cost_usd: cost.cost,
            cost_uncertain: cost.uncertain > 0,
            duration_ms: Date.now() - started,
            finding: reason,
            evidence: { observation_complete: false },
          };
        }
        state.finish(cellKey, result);
        console.log(
          `${run}/${scenario.id}: ${result.status}; ${
            result.checks
              .filter((check) => !check.pass)
              .map((check) => check.name)
              .join(', ') || 'deterministic checks passed'
          }`,
        );
        await report();
      }
    }),
  );
  await report();
  const rows = results();
  console.log(
    `Finished ${rows.length} cells: ${rows.filter((row) => row.status === 'passed').length} deterministic passes, ${rows.filter((row) => row.status === 'failed').length} failures, ${rows.filter((row) => row.status === 'not_run').length} not run. Total task spend/reservations: $${state.used().toFixed(6)}.`,
  );
  if (
    options.gate &&
    (provider !== 'fireworks' ||
      rows.some((row) => row.status !== 'passed' || row.rubric.status !== 'passed'))
  )
    process.exitCode = 1;
} catch (error) {
  interrupted = true;
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  for (const lab of labs)
    await lab.close().catch((error: unknown) => {
      console.error(safeError(error));
      process.exitCode = 1;
    });
  for (const workerState of workerStates) workerState.close();
  state.close();
  await unlink(lockPath).catch(() => undefined);
  if (interrupted)
    console.error('Campaign did not complete. The durable journal remains resumable.');
}
