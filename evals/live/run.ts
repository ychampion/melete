/**
 * The live benchmark: the task set run against a live install over its HTTP
 * API, scored against the bars for charging. See evals/live/README.md.
 *
 *   MELETE_BENCH_URL=https://melete.example.com MELETE_BENCH_EMAIL=… MELETE_BENCH_PASSWORD=… \
 *     bun run evals/live/run.ts --category errand,human_check,research
 *   bun run evals/live/run.ts --jobs 100 --spend-cap 10
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LiveClient } from './client.ts';
import { runJob } from './driver.ts';
import { fireworksGrader } from './rubric.ts';
import { renderReport, scoreBars } from './score.ts';
import { reachable } from './sites.ts';
import { TASKS } from './tasks.ts';
import { CATEGORIES, type Category, type JobRecord, type RunResult, type Task } from './types.ts';

/** A small seeded generator, so a sampled run can be repeated. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The order jobs run in: each task once, or `jobs` draws with repeats. */
export function plan(tasks: readonly Task[], jobs: number | null, seed: number): Task[] {
  if (jobs === null) return [...tasks];
  const random = seeded(seed);
  return Array.from({ length: jobs }, () => tasks[Math.floor(random() * tasks.length)] as Task);
}

export function select(
  tasks: readonly Task[],
  categories: readonly string[] | null,
  ids: readonly string[] | null,
): Task[] {
  for (const category of categories ?? [])
    if (!CATEGORIES.includes(category as Category)) throw new Error(`Unknown category ${category}`);
  for (const id of ids ?? [])
    if (!tasks.some((task) => task.id === id)) throw new Error(`Unknown task ${id}`);
  return tasks.filter(
    (task) =>
      (!categories || categories.includes(task.category)) && (!ids || ids.includes(task.id)),
  );
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    strict: true,
    options: {
      url: { type: 'string' },
      category: { type: 'string' },
      task: { type: 'string' },
      jobs: { type: 'string' },
      seed: { type: 'string', default: '20261010' },
      'spend-cap': { type: 'string', default: '5' },
      'out-dir': { type: 'string', default: '.eval-state/live' },
      name: { type: 'string' },
      rubric: { type: 'boolean', default: false },
      'keep-chats': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
    },
  });
  const list = (value: string | undefined) =>
    value
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : null;
  const tasks = select(TASKS, list(values.category), list(values.task));
  if (values.list) {
    for (const task of tasks)
      console.log(
        `${task.id.padEnd(30)} ${task.category.padEnd(12)} ${task.budget_s}s  ${task.title}`,
      );
    return;
  }

  const env = process.env;
  const url = values.url ?? env.MELETE_BENCH_URL;
  const email = env.MELETE_BENCH_EMAIL;
  const password = env.MELETE_BENCH_PASSWORD;
  if (!url || !email || !password)
    throw new Error(
      'Set MELETE_BENCH_URL (or --url), MELETE_BENCH_EMAIL and MELETE_BENCH_PASSWORD.',
    );
  const jobs = values.jobs ? Number(values.jobs) : null;
  if (jobs !== null && (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 1000))
    throw new Error('--jobs takes 1 to 1000');
  const seed = Number(values.seed);
  const cap = Number(values['spend-cap']);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('--spend-cap takes dollars above 0');

  const client = new LiveClient(url);
  const { version } = await client.locate();
  await client.signIn(email, password);
  const log = (line: string) => console.log(line);
  log(`signed in to ${new URL(url).host} (version ${version ?? 'unknown'})`);

  const name = values.name ?? `live-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const outDir = resolve(values['out-dir']);
  mkdirSync(outDir, { recursive: true });
  const result: RunResult = {
    started_at: new Date().toISOString(),
    finished_at: '',
    install: { version, host: new URL(url).host },
    mode: jobs === null ? 'once' : 'sample',
    seed,
    spend_cap_usd: cap,
    spend_usd: null,
    stopped_for_spend: false,
    jobs: [],
    bars: [],
    cleanup: [],
  };
  const write = () => {
    result.bars = scoreBars(result.jobs);
    result.finished_at = new Date().toISOString();
    for (const [extension, body] of [
      ['json', `${JSON.stringify(result, null, 2)}\n`],
      ['md', renderReport(result)],
    ] as const) {
      const path = join(outDir, `${name}.${extension}`);
      writeFileSync(`${path}.tmp`, body);
      renameSync(`${path}.tmp`, path);
    }
  };

  // A site that does not answer skips its tasks rather than failing them.
  const down = new Set<string>();
  for (const site of new Set(tasks.map((task) => task.site)))
    if (/\./.test(site) && !(await reachable(`https://${site}`))) down.add(site);
  if (down.size) log(`sites not answering: ${[...down].join(', ')}`);

  // The GitHub errand needs the agent's computer to reach the test account.
  let installed: string | null = null;
  if (tasks.some((task) => task.id === 'github-issue') && env.MELETE_BENCH_GITHUB_TOKEN) {
    const existing = (await client.connections()).find((connection) =>
      /github/i.test(`${connection.label ?? ''} ${connection.name ?? ''}`),
    );
    if (!existing) {
      installed = await client.installConnection({
        label: 'GitHub (benchmark)',
        provider: 'command_line',
        command_line: { adapter: 'github' },
        credentials: { token: env.MELETE_BENCH_GITHUB_TOKEN },
        scopes: ['egress.github_read', 'egress.github_write'],
      });
      log('added a GitHub connection for the run');
    }
  }

  const spent = { usd: 0 };
  const grader =
    values.rubric && env.FIREWORKS_API_KEY
      ? fireworksGrader(env.FIREWORKS_API_KEY, spent)
      : undefined;
  const spendStart = await client.spend();
  const order = plan(tasks, jobs, seed);
  try {
    for (const [index, task] of order.entries()) {
      const now = await client.spend();
      const used = now === null || spendStart === null ? null : now - spendStart + spent.usd;
      result.spend_usd = used;
      if (used !== null && used >= cap) {
        result.stopped_for_spend = true;
        log(`spend cap of $${cap} reached after ${index} jobs`);
        break;
      }
      log(`[${index + 1}/${order.length}] ${task.id}`);
      let record: JobRecord;
      if (down.has(task.site)) {
        record = await runJob(
          client,
          { ...task, setup: async () => Promise.reject(new Error('the site did not answer')) },
          {
            index: index + 1,
            env,
          },
        );
      } else {
        try {
          record = await runJob(client, task, {
            index: index + 1,
            env,
            keepChat: values['keep-chats'],
            ...(grader ? { rubric: grader } : {}),
            log,
          });
        } catch (caught) {
          record = {
            job: index + 1,
            task: task.id,
            category: task.category,
            site: task.site,
            outcome: 'error',
            reason: (caught as Error).message,
            wall_s: null,
            steps: 0,
            approvals: 0,
            questions: 0,
            handoffs: [],
            unshown_check: false,
            claims: [],
            stopped: false,
            rubric: null,
            reply: '',
            tools: [],
            started_at: new Date().toISOString(),
            cleanup: [],
            spend_usd: null,
          };
        }
      }
      result.jobs.push(record);
      log(
        `  ${record.outcome} in ${record.wall_s ?? '—'} s, ${record.steps} steps, ${record.approvals} approvals${record.claims.length ? `, ${record.claims.length} unsupported claims` : ''}: ${record.reason}`,
      );
      write();
    }
  } finally {
    const files = [
      ...new Set(
        result.jobs.flatMap((job) =>
          job.cleanup.filter((line) => line.startsWith('file:')).map((line) => line.slice(5)),
        ),
      ),
    ];
    if (files.length) result.cleanup.push(await removeFiles(client, files));
    if (installed) {
      await client
        .revokeConnection(installed)
        .then(() => result.cleanup.push('removed the GitHub connection added for the run'))
        .catch((caught) =>
          result.cleanup.push(`GitHub connection not removed (${(caught as Error).message})`),
        );
    }
    const end = await client.spend();
    if (end !== null && spendStart !== null) result.spend_usd = end - spendStart + spent.usd;
    write();
    log(`wrote ${join(outDir, `${name}.md`)}`);
  }
}

/**
 * Files the jobs saved are removed the way a person would remove them: by
 * asking Melete in one chat, allowing what it asks, then deleting that chat.
 */
async function removeFiles(client: LiveClient, files: readonly string[]): Promise<string> {
  const task: Task = {
    id: 'clean-up',
    category: 'everyday',
    title: 'Clean up test files',
    site: 'none',
    budget_s: 300,
    prompt: () =>
      `Please delete these files from my Files; they were test output and I don't need them: ${files.join(', ')}. Don't touch anything else.`,
    check: () => ({ pass: true, reason: '' }),
  };
  const record = await runJob(client, task, { index: 0, env: {} });
  return `asked Melete to delete ${files.length} saved files: ${record.outcome === 'pass' ? 'done' : record.outcome} (${record.approvals} approvals)`;
}

if (import.meta.main)
  await main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
