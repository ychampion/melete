/**
 * Keeps one issue open per workflow while that workflow fails on main, and
 * closes it once the same jobs pass again. `.github/workflows/main-health.yml`
 * runs it after each run of a workflow that tests main.
 *
 * On a failure the issue names the commit, the run, the failed jobs and steps,
 * the end of the failed step's log, the last commit the workflow passed on, and
 * the pull requests merged since then. Log text is untrusted: it only ever
 * reaches the issue through a file passed to `gh`, inside a code fence longer
 * than any run of backticks it holds, and is never handed to a shell.
 *
 * Everything that talks to GitHub goes through one `gh` function with an
 * argument array, so the test can stand in for it.
 */

export const LABEL = 'main-failing';
export const AUTOFIX_LABEL = 'main-autofix';
export const LOG_LINES = 80;
const MAX_LINE = 400;
const MAX_BODY = 60_000;
const MAX_COMMITS_LOOKED_UP = 60;
const SHA = /^[0-9a-f]{40}$/;

export type Gh = (args: string[]) => string;

export type Step = { name: string; conclusion: string | null };
export type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  html_url: string;
  steps?: Step[];
};
export type Run = { head_sha: string; created_at: string; event: string; html_url: string };
export type PullRequest = { number: number; title: string; url: string };

export type Marker = { workflowId: string; sha: string; jobs: string[] };

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

export function isFailed(conclusion: string | null | undefined): boolean {
  return conclusion != null && FAILED.has(conclusion);
}

/** The hidden line that ties an issue to one workflow and records what failed. */
export function marker(m: Marker): string {
  return `<!-- main-health workflow=${m.workflowId} sha=${m.sha} jobs=${encodeURIComponent(
    JSON.stringify(m.jobs),
  )} -->`;
}

export function readMarker(body: string): Marker | null {
  const match = body.match(/<!-- main-health workflow=(\d+) sha=([0-9a-f]{40}) jobs=(\S*) -->/);
  if (!match) return null;
  let jobs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match[3] ?? ''));
    if (Array.isArray(parsed)) jobs = parsed.filter((j): j is string => typeof j === 'string');
  } catch {
    jobs = [];
  }
  return { workflowId: match[1] ?? '', sha: match[2] ?? '', jobs };
}

export function issueTitle(workflowName: string, failedJobs: string[]): string {
  const first = failedJobs[0] ?? 'a job';
  const more = failedJobs.length > 1 ? ` (+${failedJobs.length - 1} more)` : '';
  return `main is failing: ${workflowName} / ${first}${more}`.slice(0, 250);
}

/**
 * The lines of a job log that explain the failure: timestamps and colour codes
 * removed, ending at the last `##[error]` line (the failed step's exit), or at
 * the end of the log when there is none.
 */
export function logTail(raw: string, lines = LOG_LINES): string {
  const clean = raw
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes are stripped on purpose.
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''),
    )
    .map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} [line cut]` : line));
  while (clean.length > 0 && clean[clean.length - 1] === '') clean.pop();
  let end = clean.length;
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i]?.startsWith('##[error]')) {
      end = i + 1;
      break;
    }
  }
  return clean.slice(Math.max(0, end - lines), end).join('\n');
}

/** A Markdown fence that the text inside cannot close. */
export function fence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Pull request numbers named in a merge or squash commit's first line. */
export function prNumbersFromMessage(message: string): number[] {
  const subject = message.split('\n')[0] ?? '';
  const merge = subject.match(/^Merge pull request #(\d+)\b/);
  if (merge) return [Number(merge[1])];
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  return squash ? [Number(squash[1])] : [];
}

/**
 * The newest successful run on main that started before the failing one and
 * tested a different commit. `runs` is newest first, as the API returns it.
 */
export function lastGreen(runs: Run[], failingSha: string, failingCreatedAt: string): Run | null {
  for (const run of runs) {
    if (run.event !== 'push' && run.event !== 'workflow_run') continue;
    if (run.head_sha === failingSha) continue;
    if (run.created_at > failingCreatedAt) continue;
    return run;
  }
  return null;
}

export type BodyInput = {
  repo: string;
  workflowId: string;
  workflowName: string;
  sha: string;
  runUrl: string;
  failedJobs: { name: string; url: string; steps: string[] }[];
  logJob: string | null;
  log: string;
  green: { sha: string; url: string } | null;
  prs: PullRequest[];
  commitCount: number | null;
  lookedUpAll: boolean;
};

export function issueBody(input: BodyInput): string {
  const server = 'https://github.com';
  const short = input.sha.slice(0, 7);
  const out: string[] = [
    marker({
      workflowId: input.workflowId,
      sha: input.sha,
      jobs: input.failedJobs.map((j) => j.name),
    }),
    `**${input.workflowName}** failed on \`main\` at [\`${short}\`](${server}/${input.repo}/commit/${input.sha}).`,
    '',
    `- Run: ${input.runUrl}`,
  ];
  for (const job of input.failedJobs) {
    const steps = job.steps.length > 0 ? job.steps.map((s) => `"${s}"`).join(', ') : 'none named';
    out.push(`- Failed job: [${job.name}](${job.url}), failed step: ${steps}`);
  }
  out.push('', '### Since it last passed', '');
  if (input.green) {
    const g = input.green.sha;
    out.push(
      `Last green run: [\`${g.slice(0, 7)}\`](${input.green.url}). ` +
        `[Compare ${g.slice(0, 7)}...${short}](${server}/${input.repo}/compare/${g}...${input.sha})` +
        (input.commitCount != null ? `, ${input.commitCount} commit(s).` : '.'),
      '',
    );
    if (input.prs.length > 0) {
      out.push('Pull requests merged in that range:', '');
      for (const pr of input.prs) out.push(`- #${pr.number} ${pr.title}`);
    } else {
      out.push('No merged pull request was found in that range.');
    }
    if (!input.lookedUpAll) {
      out.push('', `Only the newest ${MAX_COMMITS_LOOKED_UP} commits were looked up.`);
    }
  } else {
    out.push('No earlier green run of this workflow on main was found.');
  }
  out.push('', `### Log${input.logJob ? `: ${input.logJob}` : ''}`, '');
  let log = input.log.length > 0 ? input.log : '(the log could not be read)';
  const head = out.join('\n');
  const room = MAX_BODY - head.length - 400;
  if (log.length > room) log = `[cut]\n${log.slice(log.length - room)}`;
  const f = fence(log);
  out.push(`The last ${LOG_LINES} lines up to the error, as GitHub recorded them:`, '');
  out.push(`${f}text`, log, f, '');
  out.push(
    'This issue closes itself when the same jobs pass on main again. ' +
      'See "When main fails" in CONTRIBUTING.md.',
  );
  return out.join('\n');
}

type Env = Record<string, string | undefined>;
type Io = {
  gh: Gh;
  writeFile: (path: string, text: string) => void;
  tempDir: string;
  log: (line: string) => void;
};

function need(env: Env, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

function json<T>(gh: Gh, args: string[]): T {
  return JSON.parse(gh(args)) as T;
}

/** How `later` relates to `earlier`: 'ahead', 'behind', 'identical' or 'diverged'. */
function order(io: Io, repo: string, earlier: string, later: string): string {
  if (earlier === later) return 'identical';
  try {
    return json<{ status: string }>(io.gh, [
      'api',
      `repos/${repo}/compare/${earlier}...${later}`,
      '--jq',
      '{status: .status}',
    ]).status;
  } catch {
    return 'unknown';
  }
}

function findIssue(io: Io, repo: string, workflowId: string) {
  const issues = json<{ number: number; body: string }[]>(io.gh, [
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    LABEL,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,body',
  ]);
  for (const issue of issues) {
    const m = readMarker(issue.body ?? '');
    if (m && m.workflowId === workflowId) return { number: issue.number, marker: m };
  }
  return null;
}

function mergedPrs(io: Io, repo: string, green: string, sha: string) {
  const compare = json<{ total_commits: number; commits: { sha: string; message: string }[] }>(
    io.gh,
    [
      'api',
      `repos/${repo}/compare/${green}...${sha}`,
      '--jq',
      '{total_commits: .total_commits, commits: [.commits[] | {sha: .sha, message: .commit.message}]}',
    ],
  );
  const commits = compare.commits.slice().reverse().slice(0, MAX_COMMITS_LOOKED_UP);
  const prs = new Map<number, PullRequest>();
  for (const commit of commits) {
    let found: PullRequest[] = [];
    try {
      found = json<PullRequest[]>(io.gh, [
        'api',
        `repos/${repo}/commits/${commit.sha}/pulls`,
        '--jq',
        '[.[] | select(.merged_at != null and .base.ref == "main") | {number: .number, title: .title, url: .html_url}]',
      ]);
    } catch {
      found = prNumbersFromMessage(commit.message).map((n) => ({
        number: n,
        title: '',
        url: `https://github.com/${repo}/pull/${n}`,
      }));
    }
    for (const pr of found) if (!prs.has(pr.number)) prs.set(pr.number, pr);
  }
  return {
    prs: [...prs.values()].sort((a, b) => a.number - b.number),
    commitCount: compare.total_commits,
    lookedUpAll: compare.total_commits <= MAX_COMMITS_LOOKED_UP,
  };
}

export type Outcome = {
  action: 'opened' | 'updated' | 'closed' | 'none';
  issue: number | null;
  failing: boolean;
  lastGreen: string | null;
};

export function run(env: Env, io: Io): Outcome {
  const repo = need(env, 'GITHUB_REPOSITORY');
  const runId = need(env, 'RUN_ID');
  const workflowId = need(env, 'WORKFLOW_ID');
  const workflowName = need(env, 'WORKFLOW_NAME');
  const sha = need(env, 'HEAD_SHA');
  const conclusion = env.CONCLUSION ?? '';
  const runUrl = need(env, 'RUN_URL');
  const createdAt = need(env, 'RUN_CREATED_AT');
  if (!SHA.test(sha)) throw new Error('HEAD_SHA is not a commit sha');
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(workflowId)) throw new Error('bad run or workflow id');

  const existing = findIssue(io, repo, workflowId);
  const jobs = json<{ jobs: Job[] }>(io.gh, [
    'api',
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
  ]).jobs;

  if (conclusion === 'success') {
    if (!existing) return { action: 'none', issue: null, failing: false, lastGreen: null };
    const relation = order(io, repo, existing.marker.sha, sha);
    if (relation !== 'ahead' && relation !== 'identical') {
      io.log(`Run is for ${sha}, not after the failing ${existing.marker.sha}; issue left open.`);
      return { action: 'none', issue: existing.number, failing: false, lastGreen: null };
    }
    const passed = new Set(jobs.filter((j) => j.conclusion === 'success').map((j) => j.name));
    const missing = existing.marker.jobs.filter((name) => !passed.has(name));
    if (missing.length > 0) {
      io.log(`These jobs did not pass in this run: ${missing.join(', ')}; issue left open.`);
      return { action: 'none', issue: existing.number, failing: false, lastGreen: null };
    }
    const note = `${io.tempDir}/fixed.md`;
    io.writeFile(note, `Fixed in ${sha}: ${runUrl}`);
    io.gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body-file', note]);
    io.gh(['issue', 'close', String(existing.number), '--repo', repo, '--reason', 'completed']);
    return { action: 'closed', issue: existing.number, failing: false, lastGreen: null };
  }

  if (!isFailed(conclusion)) {
    io.log(`Conclusion "${conclusion}" is neither a pass nor a failure; nothing to do.`);
    return { action: 'none', issue: existing?.number ?? null, failing: false, lastGreen: null };
  }

  if (existing && order(io, repo, existing.marker.sha, sha) === 'behind') {
    io.log(`The open issue already reports a newer commit than ${sha}; left as it is.`);
    return { action: 'none', issue: existing.number, failing: false, lastGreen: null };
  }

  const failed = jobs.filter((j) => isFailed(j.conclusion));
  const failedJobs = failed.map((j) => ({
    name: j.name,
    url: j.html_url,
    steps: (j.steps ?? []).filter((s) => isFailed(s.conclusion)).map((s) => s.name),
  }));
  let log = '';
  const logJob = failed[0] ?? null;
  if (logJob) {
    try {
      log = logTail(io.gh(['api', `repos/${repo}/actions/jobs/${logJob.id}/logs`]));
    } catch (error) {
      io.log(`Could not read the log: ${(error as Error).message}`);
    }
  }

  const runs = json<{ workflow_runs: Run[] }>(io.gh, [
    'api',
    `repos/${repo}/actions/workflows/${workflowId}/runs?branch=main&status=success&per_page=50`,
  ]).workflow_runs;
  const green = lastGreen(runs, sha, createdAt);
  let range = { prs: [] as PullRequest[], commitCount: null as number | null, lookedUpAll: true };
  if (green) {
    try {
      range = mergedPrs(io, repo, green.head_sha, sha);
    } catch (error) {
      io.log(`Could not compare with the last green commit: ${(error as Error).message}`);
    }
  }

  const body = issueBody({
    repo,
    workflowId,
    workflowName,
    sha,
    runUrl,
    failedJobs,
    logJob: logJob?.name ?? null,
    log,
    green: green ? { sha: green.head_sha, url: green.html_url } : null,
    ...range,
  });
  const title = issueTitle(
    workflowName,
    failedJobs.map((j) => j.name),
  );
  const bodyFile = `${io.tempDir}/issue.md`;
  io.writeFile(bodyFile, body);

  let number: number;
  let action: Outcome['action'];
  if (existing) {
    number = existing.number;
    io.gh([
      'issue',
      'edit',
      String(number),
      '--repo',
      repo,
      '--title',
      title,
      '--body-file',
      bodyFile,
    ]);
    if (existing.marker.sha !== sha) {
      const note = `${io.tempDir}/still.md`;
      io.writeFile(note, `Still failing at ${sha}: ${runUrl}`);
      io.gh(['issue', 'comment', String(number), '--repo', repo, '--body-file', note]);
    }
    action = 'updated';
  } else {
    const url = io
      .gh([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        title,
        '--label',
        LABEL,
        '--body-file',
        bodyFile,
      ])
      .trim();
    number = Number(url.split('/').pop());
    action = 'opened';
  }
  return { action, issue: number, failing: true, lastGreen: green?.head_sha ?? null };
}

if (import.meta.main) {
  const { appendFileSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const gh: Gh = (args) => {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      throw new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString();
  };
  const tempDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'main-health-'));
  const outcome = run(process.env, {
    gh,
    tempDir,
    writeFile: (path, text) => writeFileSync(path, text),
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify(outcome));
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(
      output,
      [
        `action=${outcome.action}`,
        `issue=${outcome.issue ?? ''}`,
        `failing=${outcome.failing}`,
        `last_green=${outcome.lastGreen ?? ''}`,
        '',
      ].join('\n'),
    );
  }
}
