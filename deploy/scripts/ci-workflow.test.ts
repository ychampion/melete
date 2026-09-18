/**
 * The workflows run on hosted runners nobody can step through, so everything they name is
 * checked here first: the YAML parses, each package script and file they refer to exists, every
 * action is pinned to a commit, and no secret is read. Both files are covered: the pull-request
 * workflow and the nightly conformance run.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  services?: Record<string, { image?: string; env?: Record<string, string>; ports?: string[] }>;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    schedule?: { cron?: string }[];
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, Job>;
};

const root = fileURLToPath(new URL('../..', import.meta.url));
/** The proof the browser sign-in branch brings; this workflow runs it the moment it lands. */
const SANDBOX_PROOF = 'apps/melete/test/integration/browser-sandbox.test.ts';

function load(relative: string) {
  const path = join(root, relative);
  const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const workflow = (source ? parse(source) : {}) as Workflow;
  const named = Object.entries(workflow.jobs ?? {});
  const jobs = named.map(([, job]) => job);
  const steps = jobs.flatMap((job) => job.steps ?? []);
  const commands = steps.flatMap((step) => (step.run ?? '').split('\n')).map((line) => line.trim());
  return { source, workflow, named, jobs, steps, commands };
}

const ci = load('.github/workflows/ci.yml');
const conformance = load('.github/workflows/conformance.yml');
const scripts = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const jobs = ci.jobs;
const steps = ci.steps;
const commands = ci.commands;

/** Whatever the workflows name on disk has to be there: a script, a Dockerfile, a test. */
function filesNamed(lines: string[]): string[] {
  return lines.flatMap((line) => [
    ...(/^bun run (\S+\.ts)/.exec(line)?.slice(1) ?? []),
    ...(/^bun test (\S+\.ts)/.exec(line)?.slice(1) ?? []),
    ...(/docker compose -f (\S+)/.exec(line)?.slice(1) ?? []),
    ...(/ -f (\S+\.\w+)(?: |$)/.exec(line.startsWith('docker build') ? line : '')?.slice(1) ?? []),
  ]);
}

describe('the continuous integration workflow', () => {
  test('parses and runs on pull requests and pushes to main', () => {
    expect(ci.source).not.toBe('');
    expect(ci.workflow.on).toHaveProperty('pull_request');
    expect(ci.workflow.on?.push?.branches).toEqual(['main']);
  });

  test('cancels a superseded run and holds read-only repository access', () => {
    expect(ci.workflow.concurrency?.['cancel-in-progress']).toBe(true);
    expect(ci.workflow.concurrency?.group).toContain('github.ref');
    expect(ci.workflow.permissions).toEqual({ contents: 'read' });
  });

  test('pins every action to a full commit', () => {
    const used = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
  });

  test('reads no secret and every job has a time limit', () => {
    expect(ci.source).not.toMatch(/secrets\./);
    expect(ci.source).not.toMatch(/docker (?:login|push)|--push/);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job['runs-on']).toMatch(/^ubuntu-/);
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
  });

  test('installs the pinned Bun with a frozen lockfile', () => {
    const setup = steps.filter((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
    expect(setup.length).toBeGreaterThan(0);
    for (const step of setup) expect(step.with?.['bun-version-file']).toBe('.bun-version');
    // Any version or configuration file an action is pointed at has to be in the tree.
    const pointed = steps.flatMap((step) =>
      Object.entries(step.with ?? {}).flatMap(([key, value]) =>
        key.endsWith('-file') && typeof value === 'string' ? [value] : [],
      ),
    );
    expect(pointed).toContain('.bun-version');
    for (const file of pointed) expect(existsSync(join(root, file))).toBe(true);
    expect(commands).toContain('bun install --frozen-lockfile');
    expect(commands.filter((line) => /^bun install\b/.test(line))).toEqual(
      commands.filter((line) => line === 'bun install --frozen-lockfile'),
    );
  });

  test('every package script it runs exists', () => {
    const named = commands.flatMap((line) => {
      const match = /^bun run ([\w:-]+)$/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
    for (const script of named) expect(Object.keys(scripts)).toContain(script);
    for (const required of [
      'typecheck',
      'lint',
      'compose:check',
      'browser:compose:check',
      'tailscale:compose:check',
      'doctor',
      'test',
      'test:plugin',
    ])
      expect(named).toContain(required);
  });

  test('the suite runs against a Postgres 17 service that can create databases', () => {
    const suite = jobs.find((job) => job.steps?.some((step) => step.run?.includes('bun run test')));
    const postgres = suite?.services?.postgres;
    expect(postgres?.image).toMatch(/^postgres:17(?:[.-]|$)/);
    // The image's bootstrap role is a superuser, so it can create each disposable database.
    const url = new URL(suite?.env?.DATABASE_URL ?? 'postgres://missing');
    expect(url.username).toBe(postgres?.env?.POSTGRES_USER ?? '');
    expect(url.password).toBe(postgres?.env?.POSTGRES_PASSWORD ?? '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(postgres?.ports).toEqual([`${url.port}:5432`]);
    expect(suite?.steps?.some((step) => step.run?.includes('libpq5'))).toBe(true);
  });

  test('builds every shipped image from a file that exists, without pushing', () => {
    const images = ci.named.find(([name]) => name === 'images')?.[1];
    const builds = (images?.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.startsWith('docker build '));
    const files = builds.map((line) => / -f (\S+)/.exec(line)?.[1] ?? '');
    expect(files.sort()).toEqual([
      'deploy/Dockerfile.melete',
      'deploy/Dockerfile.web',
      'packages/runtime-hermes/Dockerfile',
    ]);
    for (const line of commands.filter((entry) => entry.startsWith('docker build '))) {
      const file = / -f (\S+)/.exec(line)?.[1] ?? '';
      const context = line.split(' ').at(-1) ?? '';
      expect(existsSync(join(root, file))).toBe(true);
      expect(existsSync(join(root, context))).toBe(true);
    }
  });
});

describe('the nightly conformance workflow', () => {
  test('parses, runs on a schedule and on request, and never on a pull request', () => {
    expect(conformance.source).not.toBe('');
    expect(conformance.workflow.on).toHaveProperty('workflow_dispatch');
    expect(conformance.workflow.on?.schedule?.length).toBe(1);
    expect(conformance.workflow.on?.schedule?.[0]?.cron).toMatch(/^[\d*/, -]+$/);
    // The deployment scenarios build and start a whole stack: too much for a pull request.
    expect(conformance.workflow.on).not.toHaveProperty('pull_request');
    expect(conformance.workflow.on).not.toHaveProperty('push');
  });

  test('holds read-only access, never overlaps itself, and bounds its time', () => {
    expect(conformance.workflow.permissions).toEqual({ contents: 'read' });
    expect(conformance.workflow.concurrency?.group).toBeTruthy();
    // A second nightly must wait rather than cancel a stack that is already running.
    expect(conformance.workflow.concurrency?.['cancel-in-progress']).toBe(false);
    expect(conformance.jobs.length).toBeGreaterThan(0);
    for (const job of conformance.jobs) {
      expect(job['runs-on']).toMatch(/^ubuntu-/);
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
  });

  test('pins every action to a full commit and reads no secret', () => {
    const used = conformance.steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
    expect(conformance.source).not.toMatch(/secrets\./);
    expect(conformance.source).not.toMatch(/docker (?:login|push)|--push/);
  });

  test('judges the host Docker before it builds or starts anything', () => {
    const order = conformance.steps.findIndex((step) =>
      step.run?.includes('deploy/scripts/docker-preflight.ts'),
    );
    const start = conformance.steps.findIndex((step) =>
      step.run?.includes('docker-compose.yml up'),
    );
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(start);
    const preflight = conformance.steps[order];
    // The runner's own versions are printed, so a refusal names the host it refused.
    expect(preflight?.run).toContain('docker version');
    expect(preflight?.run).toContain('docker compose version');
  });

  test('configures a disposable stack, runs the scenarios and takes it down', () => {
    expect(conformance.commands).toContain('bun run deploy/scripts/configure.ts --fake');
    expect(conformance.commands).toContain('bun run compose:check');
    expect(
      conformance.commands.some((line) =>
        line.startsWith('docker compose -f deploy/docker-compose.yml up -d --build --wait'),
      ),
    ).toBe(true);
    const scenarios = conformance.steps.find(
      (step) => step.env?.MELETE_CONFORMANCE_COMPOSE === '1',
    );
    expect(scenarios?.run).toContain('bun run conformance');
    // A pipe must not swallow a failing run.
    expect(scenarios?.run).toContain('set -o pipefail');
    const down = conformance.steps.find((step) => step.run?.includes('down -v'));
    expect(down?.if).toBe('always()');
  });

  test('keeps the report and the stack logs when a run fails', () => {
    const upload = conformance.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload?.if).toBe('failure()');
    const paths = String(upload?.with?.path ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(paths).toEqual(['conformance-report.txt', 'compose-logs.txt']);
    // Every file it keeps is one an earlier step writes.
    for (const file of paths)
      expect(conformance.commands.some((line) => line.includes(file))).toBe(true);
  });

  test('every script, compose file and package script both workflows name exists', () => {
    // The renderer sandbox proof arrives on its own branch; the job guards its absence and
    // the test below holds that guard to naming this exact path.
    for (const line of [...commands, ...conformance.commands])
      for (const file of filesNamed([line]))
        if (file !== SANDBOX_PROOF)
          expect([line, existsSync(join(root, file))]).toEqual([line, true]);
    const named = conformance.commands.flatMap((line) => {
      // The scenarios are piped through tee, so a named script may carry a pipe after it.
      const match = /^bun run ([\w:-]+)(?: \||$)/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
    expect(named).toContain('compose:check');
    expect(named).toContain('conformance');
    for (const script of named) expect(Object.keys(scripts)).toContain(script);
  });
});
