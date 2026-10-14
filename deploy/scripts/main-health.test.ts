/**
 * The main-health report and the base-freshness guard, checked without GitHub:
 * the report runs against a stand-in for `gh`, the guard against a throwaway git
 * repository, and the workflow files are read to confirm main-health watches
 * every workflow that tests main.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  fence,
  type Gh,
  issueTitle,
  lastGreen,
  logTail,
  marker,
  prNumbersFromMessage,
  type Run,
  readMarker,
  run,
} from '../../.github/scripts/main-health.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const workflows = join(root, '.github', 'workflows');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('log tail', () => {
  test('drops timestamps and colour codes and ends at the last error', () => {
    const raw = [
      '﻿2026-10-01T10:00:00.1234567Z ##[group]Run bun test',
      '2026-10-01T10:00:01.0000000Z \u001b[31mexpected 1, got 2\u001b[0m',
      '2026-10-01T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
      '2026-10-01T10:00:03.0000000Z Post job cleanup.',
      '',
    ].join('\n');
    expect(logTail(raw)).toBe(
      '##[group]Run bun test\nexpected 1, got 2\n##[error]Process completed with exit code 1.',
    );
  });

  test('keeps at most the requested number of lines', () => {
    const raw = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const tail = logTail(raw, 80).split('\n');
    expect(tail).toHaveLength(80);
    expect(tail[79]).toBe('line 199');
  });

  test('cuts very long lines', () => {
    expect(logTail('x'.repeat(5000)).length).toBeLessThan(500);
  });
});

describe('issue text', () => {
  test('a fence is longer than any backtick run in the log', () => {
    expect(fence('plain')).toBe('```');
    expect(fence('a ```` b')).toBe('`````');
  });

  test('the marker survives a round trip, job names included', () => {
    const m = { workflowId: '42', sha: SHA_A, jobs: ['Install with --> odd name', 'Lint'] };
    expect(readMarker(`text\n${marker(m)}\nmore`)).toEqual(m);
    expect(readMarker('no marker here')).toBeNull();
  });

  test('the title names the workflow and the first failed job', () => {
    expect(issueTitle('Install', ['Install with the one-line command'])).toBe(
      'main is failing: Install / Install with the one-line command',
    );
    expect(issueTitle('CI', ['Lint', 'Tests'])).toBe('main is failing: CI / Lint (+1 more)');
  });

  test('pull request numbers come from merge and squash subjects', () => {
    expect(prNumbersFromMessage('Merge pull request #389 from someone/branch\n\nBody')).toEqual([
      389,
    ]);
    expect(prNumbersFromMessage('Fix the installer (#12)')).toEqual([12]);
    expect(prNumbersFromMessage('Plain commit')).toEqual([]);
  });

  test('the last green run is the newest earlier pass on another commit', () => {
    const runs: Run[] = [
      { head_sha: SHA_C, created_at: '2026-10-03T00:00:00Z', event: 'push', html_url: 'u3' },
      { head_sha: SHA_B, created_at: '2026-10-02T00:00:00Z', event: 'push', html_url: 'u2' },
      { head_sha: SHA_A, created_at: '2026-10-01T00:00:00Z', event: 'push', html_url: 'u1' },
    ];
    expect(lastGreen(runs, SHA_B, '2026-10-02T00:00:00Z')?.head_sha).toBe(SHA_A);
    expect(lastGreen(runs, SHA_C, '2026-10-04T00:00:00Z')?.head_sha).toBe(SHA_B);
    const manual: Run[] = [{ ...runs[2], event: 'workflow_dispatch' } as Run];
    expect(lastGreen(manual, SHA_B, '2026-10-05T00:00:00Z')).toBeNull();
  });
});

type Call = string[];
type Issue = { number: number; body: string; state: string; comments: string[] };

/** A stand-in for `gh` holding one repository's issues, runs and history. */
function fakeGithub(options: {
  issues?: Issue[];
  jobs: { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }[];
  log?: string;
  greenRuns?: Run[];
  order?: Record<string, string>;
}) {
  const calls: Call[] = [];
  const issues = options.issues ?? [];
  const files = new Map<string, string>();
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? '';
  const gh: Gh = (args) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === 'issue' && sub === 'list') {
      return JSON.stringify(
        issues.filter((i) => i.state === 'open').map((i) => ({ number: i.number, body: i.body })),
      );
    }
    if (cmd === 'issue' && sub === 'create') {
      const issue = {
        number: 100 + issues.length,
        body: files.get(flag(args, '--body-file')) ?? '',
        state: 'open',
        comments: [],
      };
      issues.push(issue);
      return `https://github.com/o/r/issues/${issue.number}\n`;
    }
    if (cmd === 'issue' && args[1] === 'edit') {
      const issue = issues.find((i) => String(i.number) === args[2]);
      if (issue) issue.body = files.get(flag(args, '--body-file')) ?? '';
      return '';
    }
    if (cmd === 'issue' && args[1] === 'comment') {
      issues
        .find((i) => String(i.number) === args[2])
        ?.comments.push(files.get(flag(args, '--body-file')) ?? '');
      return '';
    }
    if (cmd === 'issue' && args[1] === 'close') {
      const issue = issues.find((i) => String(i.number) === args[2]);
      if (issue) issue.state = 'closed';
      return '';
    }
    const path = args[1] ?? '';
    if (cmd === 'api' && path.includes('/actions/runs/') && path.includes('/jobs')) {
      return JSON.stringify({
        jobs: options.jobs.map((j, i) => ({
          id: i + 1,
          html_url: `https://github.com/o/r/actions/runs/1/job/${i + 1}`,
          steps: [],
          ...j,
        })),
      });
    }
    if (cmd === 'api' && path.includes('/actions/jobs/')) return options.log ?? '';
    if (cmd === 'api' && path.includes('/actions/workflows/')) {
      return JSON.stringify({ workflow_runs: options.greenRuns ?? [] });
    }
    if (cmd === 'api' && path.includes('/compare/')) {
      const range = path.split('/compare/')[1] ?? '';
      if (args.includes('{status: .status}')) {
        return JSON.stringify({ status: options.order?.[range] ?? 'ahead' });
      }
      return JSON.stringify({
        total_commits: 2,
        commits: [
          { sha: '1'.repeat(40), message: 'Merge pull request #7 from o/one' },
          { sha: '2'.repeat(40), message: 'Merge pull request #8 from o/two' },
        ],
      });
    }
    if (cmd === 'api' && path.endsWith('/pulls')) {
      const n = path.includes('1'.repeat(40)) ? 7 : 8;
      return JSON.stringify([{ number: n, title: `Change ${n}`, url: `u${n}` }]);
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const io = {
    gh,
    tempDir: '/tmp/x',
    writeFile: (path: string, text: string) => files.set(path, text),
    log: () => {},
  };
  return { io, calls, issues };
}

const env = (sha: string, conclusion: string) => ({
  GITHUB_REPOSITORY: 'o/r',
  RUN_ID: '1',
  WORKFLOW_ID: '42',
  WORKFLOW_NAME: 'Install',
  HEAD_SHA: sha,
  CONCLUSION: conclusion,
  RUN_URL: 'https://github.com/o/r/actions/runs/1',
  RUN_CREATED_AT: '2026-10-02T00:00:00Z',
});

describe('the report', () => {
  const failingJobs = [
    { name: 'Check install.sh with shellcheck', conclusion: 'success' },
    {
      name: 'Install with the one-line command on a clean machine',
      conclusion: 'failure',
      steps: [
        { name: 'Set up job', conclusion: 'success' },
        { name: 'Create the first account', conclusion: 'failure' },
      ],
    },
  ];

  test('a failure opens one issue with the step, log, last green commit and merged PRs', () => {
    const gh = fakeGithub({
      jobs: failingJobs,
      log: '2026-10-02T00:00:00Z curl: (22) 401 ```\n2026-10-02T00:00:01Z ##[error]exit 1',
      greenRuns: [
        {
          head_sha: SHA_A,
          created_at: '2026-10-01T00:00:00Z',
          event: 'workflow_run',
          html_url: 'g',
        },
      ],
    });
    const outcome = run(env(SHA_B, 'failure'), gh.io);
    expect(outcome).toEqual({ action: 'opened', issue: 100, failing: true, lastGreen: SHA_A });
    const body = gh.issues[0]?.body ?? '';
    expect(body).toContain('"Create the first account"');
    expect(body).toContain('#7 Change 7');
    expect(body).toContain('#8 Change 8');
    expect(body).toContain(`compare/${SHA_A}...${SHA_B}`);
    expect(body).toContain('````text\ncurl: (22) 401 ```\n##[error]exit 1\n````');
    const create = gh.calls.find((c) => c[0] === 'issue' && c[1] === 'create') ?? [];
    expect(create).toContain('main-failing');
    expect(create[create.indexOf('--title') + 1]).toBe(
      'main is failing: Install / Install with the one-line command on a clean machine',
    );
  });

  test('a later failure updates the same issue and notes the new commit', () => {
    const open = {
      number: 5,
      body: marker({ workflowId: '42', sha: SHA_A, jobs: ['x'] }),
      state: 'open',
      comments: [] as string[],
    };
    const gh = fakeGithub({ issues: [open], jobs: failingJobs });
    const outcome = run(env(SHA_B, 'failure'), gh.io);
    expect(outcome.action).toBe('updated');
    expect(gh.issues).toHaveLength(1);
    expect(readMarker(open.body)?.sha).toBe(SHA_B);
    expect(open.comments[0]).toContain(`Still failing at ${SHA_B}`);
  });

  test('a pass of the failed jobs on a later commit closes the issue', () => {
    const open = {
      number: 5,
      body: marker({
        workflowId: '42',
        sha: SHA_A,
        jobs: ['Install with the one-line command on a clean machine'],
      }),
      state: 'open',
      comments: [] as string[],
    };
    const gh = fakeGithub({
      issues: [open],
      jobs: [
        { name: 'Install with the one-line command on a clean machine', conclusion: 'success' },
      ],
    });
    expect(run(env(SHA_B, 'success'), gh.io).action).toBe('closed');
    expect(open.state).toBe('closed');
    expect(open.comments[0]).toContain(`Fixed in ${SHA_B}`);
  });

  test('a pass that skipped the failed job leaves the issue open', () => {
    const open = {
      number: 5,
      body: marker({ workflowId: '42', sha: SHA_A, jobs: ['Install'] }),
      state: 'open',
      comments: [] as string[],
    };
    const gh = fakeGithub({
      issues: [open],
      jobs: [
        { name: 'Lint', conclusion: 'success' },
        { name: 'Install', conclusion: 'skipped' },
      ],
    });
    expect(run(env(SHA_B, 'success'), gh.io).action).toBe('none');
    expect(open.state).toBe('open');
  });

  test('a pass on an older commit leaves the issue open', () => {
    const open = {
      number: 5,
      body: marker({ workflowId: '42', sha: SHA_B, jobs: ['Install'] }),
      state: 'open',
      comments: [] as string[],
    };
    const gh = fakeGithub({
      issues: [open],
      jobs: [{ name: 'Install', conclusion: 'success' }],
      order: { [`${SHA_B}...${SHA_A}`]: 'behind' },
    });
    expect(run(env(SHA_A, 'success'), gh.io).action).toBe('none');
    expect(open.state).toBe('open');
  });

  test('a cancelled run changes nothing', () => {
    const gh = fakeGithub({ jobs: [] });
    expect(run(env(SHA_A, 'cancelled'), gh.io).action).toBe('none');
    expect(gh.calls.some((c) => c[1] === 'create')).toBe(false);
  });

  test('a malformed sha is refused before anything is written', () => {
    const gh = fakeGithub({ jobs: [] });
    expect(() => run(env('$(boom)', 'failure'), gh.io)).toThrow();
    expect(gh.calls).toHaveLength(0);
  });
});

type Workflow = {
  name: string;
  on: Record<string, { branches?: string[]; workflows?: string[] } | null>;
  jobs: Record<string, { permissions?: Record<string, string>; steps?: { uses?: string }[] }>;
};

function readWorkflows(): Map<string, Workflow> {
  const out = new Map<string, Workflow>();
  for (const file of readdirSync(workflows)) {
    if (!file.endsWith('.yml')) continue;
    out.set(file, parse(readFileSync(join(workflows, file), 'utf8')) as Workflow);
  }
  return out;
}

describe('the main-health workflow', () => {
  const all = readWorkflows();
  const health = all.get('main-health.yml') as Workflow;

  test('watches every workflow that runs for main, and nothing else', () => {
    const testsMain = [...all.entries()]
      .filter(([file]) => file !== 'main-health.yml')
      .filter(([, wf]) => {
        const push = wf.on.push?.branches?.includes('main');
        const chained = wf.on.workflow_run?.branches?.includes('main');
        return push || chained;
      })
      .map(([, wf]) => wf.name)
      .sort();
    expect([...(health.on.workflow_run?.workflows ?? [])].sort()).toEqual(testsMain);
  });

  test('pins every action to a full commit sha', () => {
    for (const file of ['main-health.yml', 'pr-base-fresh.yml']) {
      const wf = all.get(file) as Workflow;
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
        }
      }
    }
  });

  test('grants each job only what it needs', () => {
    expect(health.jobs.report?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'write',
      'pull-requests': 'read',
    });
    expect(health.jobs.autofix?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
      issues: 'write',
    });
    const fresh = all.get('pr-base-fresh.yml') as Workflow;
    expect(Object.keys(fresh.on)).toEqual(['pull_request']);
  });
});

describe('the base-freshness guard', () => {
  const script = join(root, '.github', 'scripts', 'pr-base-fresh.sh');

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'base-fresh-'));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    const commit = (path: string, text: string) => {
      const full = join(dir, path);
      Bun.spawnSync(['mkdir', '-p', join(full, '..')]);
      writeFileSync(full, text);
      git('add', '-A');
      git('commit', '-q', '-m', `change ${path}`);
    };
    git('init', '-q', '-b', 'main');
    commit('README.md', 'one');
    git('switch', '-q', '-c', 'feature');
    commit('src/a.ts', 'feature');
    git('switch', '-q', 'main');
    const check = () => {
      const r = Bun.spawnSync(['bash', script, 'main', 'feature'], {
        cwd: dir,
        env: { ...process.env, GITHUB_ACTIONS: '' },
      });
      return { code: r.exitCode, out: r.stdout.toString() };
    };
    return { dir, commit, check };
  }

  test('passes a branch that main has not moved past', () => {
    const r = repo();
    expect(r.check().code).toBe(0);
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('passes when main only changed unwatched paths', () => {
    const r = repo();
    r.commit('docs/notes.md', 'x');
    expect(r.check().code).toBe(0);
    rmSync(r.dir, { recursive: true, force: true });
  });

  test('fails with a plain message when main changed a watched path', () => {
    for (const path of [
      'install.sh',
      'deploy/docker-compose.yml',
      '.github/workflows/ci.yml',
      'apps/melete/drizzle/0001_x.sql',
      'packages/contracts/src/a.ts',
    ]) {
      const r = repo();
      r.commit(path, 'x');
      const result = r.check();
      expect(result.code).toBe(1);
      expect(result.out).toContain(path);
      expect(result.out).toContain(
        'Merge main into this branch so CI tests it against current main.',
      );
      rmSync(r.dir, { recursive: true, force: true });
    }
  });
});
