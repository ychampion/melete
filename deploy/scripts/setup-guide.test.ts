import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GUIDE, setupBlocks, setupScript, unexpected } from './setup-guide.ts';
import type { Check } from './status.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const guide = readFileSync(join(root, GUIDE), 'utf8');

describe("the guide's main path", () => {
  const blocks = setupBlocks(guide);
  const script = blocks.join('\n');

  test('holds every step an agent runs, in order', () => {
    const order = [
      'docker compose version',
      'bun run doctor --docker',
      'bun run deploy/scripts/configure.ts --connect-in-app',
      'bun run deploy/scripts/set-env.ts MELETE_IMAGE_TAG=main',
      'docker compose -f deploy/docker-compose.yml pull',
      'docker compose -f deploy/docker-compose.yml up -d --no-build --wait',
      'bun run deploy/scripts/status.ts',
    ];
    const positions = order.map((command) => script.indexOf(command));
    for (const [index, command] of order.entries())
      expect(positions[index], command).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('never builds, never clones over the checkout, and reads no key', () => {
    expect(script).not.toMatch(/(^|\s)--build/);
    expect(script).not.toContain('git clone');
    expect(script).not.toMatch(/read -rs|_API_KEY/);
  });

  test('every script it runs exists', () => {
    for (const [, file] of script.matchAll(/bun run (\S+\.ts)/g))
      expect(existsSync(join(root, file ?? '')), file).toBe(true);
  });

  test('an indented block loses its indentation, and an unclosed one is refused', () => {
    expect(setupBlocks('- item\n\n  ```bash setup\n  echo one\n    echo two\n  ```\n')).toEqual([
      'echo one\n  echo two',
    ]);
    expect(setupBlocks('```bash\nnot this\n```\n')).toEqual([]);
    expect(() => setupBlocks('```bash setup\necho\n')).toThrow('never closed');
  });

  test('the script stops at the first failure', () => {
    const text = setupScript(['echo a', 'echo b']);
    expect(text.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n')).toBe(true);
    expect(text).toContain('setup block 2 of 2');
  });
});

describe('what the status report must say', () => {
  const ok = (name: string): Check => ({ level: 'ok', name, detail: '' });
  const base = ['Docker', 'Disk', 'Configuration', 'Images', 'Services', 'API'].map(ok);
  const model: Check = { level: 'warn', name: 'Model', detail: 'no key' };
  const noAccount: Check = { level: 'warn', name: 'Account', detail: 'No account yet.' };

  test('before the account: only the model and the account may wait', () => {
    expect(unexpected([...base, model, noAccount], 'before')).toEqual([]);
    expect(unexpected([...base, model, ok('Account')], 'before')).toEqual(['Account: ok, ']);
  });

  test('after the account: only the model may wait', () => {
    expect(unexpected([...base, model, ok('Account')], 'after')).toEqual([]);
    expect(unexpected([...base, model, noAccount], 'after')).toHaveLength(1);
  });

  test('a failure anywhere, or a check that is missing, is unexpected', () => {
    const down: Check = { level: 'fail', name: 'Services', detail: 'web unhealthy' };
    expect(
      unexpected([...base.filter((c) => c.name !== 'Services'), down, model, noAccount], 'before'),
    ).toEqual(['Services: fail, web unhealthy']);
    expect(unexpected([ok('Docker')], 'after')).toContain('API: not reported');
    expect(unexpected([...base, { ...model, level: 'fail' }, ok('Account')], 'after')).toHaveLength(
      1,
    );
  });
});

describe('the setup-guide workflow', () => {
  const source = readFileSync(join(root, '.github/workflows/setup-guide.yml'), 'utf8');
  const workflow = parse(source) as {
    on: { pull_request: { paths: string[] }; push: { branches: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { 'timeout-minutes'?: number; steps: { uses?: string; run?: string }[] }>;
  };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

  test('runs for changes to the guide or the deployment, and on main', () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([GUIDE, 'deploy/**', '.github/workflows/setup-guide.yml']),
    );
    expect(workflow.on.push.branches).toEqual(['main']);
  });

  test('is read-only, pinned, time-limited and reads no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(source).not.toMatch(/secrets\./);
    for (const job of Object.values(workflow.jobs))
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    for (const step of steps)
      if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
  });

  test('runs the guide itself, checks the report twice and removes the stack', () => {
    const runs = steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('bun run deploy/scripts/setup-guide.ts script');
    expect(runs).toContain('setup-guide.ts expect before');
    expect(runs).toContain('setup-guide.ts expect after');
    expect(runs).toContain('down -v');
  });
});
