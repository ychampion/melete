/**
 * The workflow runs on a hosted runner nobody can step through, so everything it
 * names is checked here first: the YAML parses, each package script and file it
 * refers to exists, every action is pinned to a commit, and no secret is read.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  'runs-on'?: string;
  'timeout-minutes'?: number;
  services?: Record<string, { image?: string; env?: Record<string, string>; ports?: string[] }>;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: { pull_request?: unknown; push?: { branches?: string[] } };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, Job>;
};

const root = fileURLToPath(new URL('../..', import.meta.url));
const path = join(root, '.github/workflows/ci.yml');
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const workflow = (source ? parse(source) : {}) as Workflow;
const scripts = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const jobs = Object.values(workflow.jobs ?? {});
const steps = jobs.flatMap((job) => job.steps ?? []);
const commands = steps.flatMap((step) => (step.run ?? '').split('\n')).map((line) => line.trim());

describe('the continuous integration workflow', () => {
  test('parses and runs on pull requests and pushes to main', () => {
    expect(source).not.toBe('');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on?.push?.branches).toEqual(['main']);
  });

  test('cancels a superseded run and holds read-only repository access', () => {
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(true);
    expect(workflow.concurrency?.group).toContain('github.ref');
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  test('pins every action to a full commit', () => {
    const used = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
  });

  test('reads no secret and every job has a time limit', () => {
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/docker (?:login|push)|--push/);
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
    const builds = commands.filter((line) => line.startsWith('docker build '));
    const files = builds.map((line) => / -f (\S+)/.exec(line)?.[1] ?? '');
    expect(files.sort()).toEqual([
      'deploy/Dockerfile.melete',
      'deploy/Dockerfile.web',
      'packages/runtime-hermes/Dockerfile',
    ]);
    for (const line of builds) {
      const file = / -f (\S+)/.exec(line)?.[1] ?? '';
      const context = line.split(' ').at(-1) ?? '';
      expect(existsSync(join(root, file))).toBe(true);
      expect(existsSync(join(root, context))).toBe(true);
    }
  });
});
