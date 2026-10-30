import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(name: string, data: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'router-profile-'));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, JSON.stringify(data));
  return { root, path };
}

test('a declared missing stage timestamp stays unknown even when observation time exists', async () => {
  const { analyzeTrace } = await import('./profile.ts');
  const result = analyzeTrace({
    version: 1,
    observations: [
      { stage: 'ingress_accepted', at: '2027-01-01T00:00:00Z', source: 'product' },
      { stage: 'attempt_started', at: null, observedAt: '2027-01-01T00:00:04Z', source: 'http' },
    ],
  });
  expect(result.timeline[1]?.at).toBeNull();
  expect(result.timeline[1]?.observationLagMs).toBeNull();
  expect(result.activeMachineMs).toBeNull();
  expect(result.humanWaitMs).toBeNull();
});

test('CLI reads result directories and writes a profile', async () => {
  const { root } = await fixture('results.json', {
    build: 'abc1234',
    model: { provider: 'local', model: 'scripted' },
    guidance: 'off',
    results: [{ task: 'route_notice', pass: true, wall_s: 2, tools: ['read', 'read'] }],
  });
  const out = join(root, 'profile.json');
  const run = Bun.spawnSync([
    'bun',
    join(import.meta.dir, 'profile.ts'),
    '--results',
    root,
    '--out',
    out,
  ]);
  expect(run.exitCode).toBe(0);
  const data = await Bun.file(out).json();
  expect(data.groups[0].attempts).toBe(1);
  expect(data.groups[0].toolCalls).toBe(2);
});

test('partial files, null durations, failures and outliers are retained without pooling settings', async () => {
  const { profileResults } = await import('./profile.ts');
  const rows = [
    { task: 'route_notice', pass: true, wall_s: 2, model_calls: 3, tool_calls: 2, cost_usd: 0.01 },
    { task: 'route_notice', pass: false, wall_s: 217.2 },
    { task: 'route_notice', wall_s: null, checks: [{ check: 'harness_error', ok: false }] },
  ];
  const result = profileResults([
    {
      name: 'run-a',
      data: { build: 'abc1234', model: 'scripted', guidance: 'off', results: rows },
    },
    {
      name: 'run-b',
      data: { build: 'abc1234', model: 'scripted', guidance: 'on', results: rows.slice(0, 1) },
    },
    { name: 'partial', data: [{ task: 'route_notice', wall_s: 196.2 }] },
  ]);
  const group = result.groups.find((g) => g.guidance === 'off' && g.task === 'route_notice');
  expect(group).toMatchObject({
    attempts: 3,
    successes: 1,
    failures: 1,
    harnessErrors: 1,
    timed: 2,
    missingDuration: 1,
    medianSeconds: 109.6,
    p95Seconds: 217.2,
    modelCalls: 3,
    toolCalls: 2,
    recordedCostUsd: 0.01,
  });
  expect(result.runs.find((r) => r.name === 'partial')?.partial).toBe(true);
  expect(result.attempts.map((a) => a.wallSeconds)).toContain(196.2);
  expect(result.groups.filter((g) => g.task === 'route_notice')).toHaveLength(3);
});

test('arbitrary task and tool names cannot be mistaken for inherited object properties', async () => {
  const { profileResults } = await import('./profile.ts');
  const result = profileResults(
    [
      {
        name: 'run',
        data: {
          build: 'abc1234',
          model: 'local/scripted',
          guidance: 'on',
          results: [
            { task: 'constructor', tools: ['__proto__', '__proto__', 'constructor'] },
            { task: '__proto__', tools: [] },
          ],
        },
      },
    ],
    JSON.parse('{"__proto__":"Neutral label"}'),
  );
  expect(result.attempts.map((a) => a.task)).toEqual(['constructor', 'Neutral label']);
  const group = result.groups.find((g) => g.task === null);
  expect(Object.entries(group?.toolCounts ?? {})).toEqual([
    ['__proto__', 2],
    ['constructor', 1],
  ]);
});

test('date-only labels leave the build unknown and do not hide a later build identifier', async () => {
  const { profileResults } = await import('./profile.ts');
  const result = profileResults([
    { name: '20270101', data: [{ task: 'notice', wall_s: null }] },
    {
      name: 'run',
      data: { label: '20270101-abc1234-gon', results: [{ task: 'notice' }] },
    },
    { name: '20270101', data: { build: '20270101', results: [] } },
  ]);
  expect(result.runs.map((r) => r.build)).toEqual(['unknown', 'abc1234', '20270101']);
});

test('trace intervals use unions and separate human time and observation lag', async () => {
  const { analyzeTrace } = await import('./profile.ts');
  const result = analyzeTrace({
    version: 1,
    observations: [
      {
        stage: 'write_completed',
        at: '2027-01-01T00:00:04Z',
        observedAt: '2027-01-01T00:00:05Z',
        jobId: 'job_a',
        attemptId: 'attempt_b',
        actionId: 'action_c',
        source: 'provider',
      },
    ],
    intervals: [
      {
        kind: 'model',
        start: '2027-01-01T00:00:00Z',
        end: '2027-01-01T00:00:02Z',
        source: 'receipt',
      },
      {
        kind: 'model',
        start: '2027-01-01T00:00:01Z',
        end: '2027-01-01T00:00:03Z',
        source: 'receipt',
      },
      {
        kind: 'machine',
        start: '2027-01-01T00:00:03Z',
        end: '2027-01-01T00:00:04Z',
        source: 'product',
      },
      { kind: 'human', start: '2027-01-01T00:00:04Z', end: '2027-01-01T00:00:09Z', source: 'http' },
    ],
  });
  expect(result.modelMs).toBe(3000);
  expect(result.overlappingModelIntervals).toBe(true);
  expect(result.activeMachineMs).toBe(4000);
  expect(result.humanWaitMs).toBe(5000);
  expect(result.timeline[0]?.observationLagMs).toBe(1000);
});

test('trace CLI works without an installation', async () => {
  const { root, path } = await fixture('trace.json', {
    version: 1,
    observations: [{ stage: 'verification_completed', at: null, source: 'provider' }],
  });
  const out = join(root, 'out.json');
  const run = Bun.spawnSync([
    'bun',
    join(import.meta.dir, 'profile.ts'),
    '--trace',
    path,
    '--out',
    out,
  ]);
  expect(run.exitCode).toBe(0);
  expect((await Bun.file(out).json()).traces[0].timeline[0].at).toBeNull();
});

test('missing interval endpoints make totals unknown while preserving measured lower bounds', async () => {
  const { analyzeTrace } = await import('./profile.ts');
  const result = analyzeTrace({
    version: 1,
    observations: [],
    intervals: [
      {
        kind: 'model',
        start: '2027-01-01T00:00:00Z',
        end: '2027-01-01T00:00:02Z',
        source: 'receipt',
      },
      { kind: 'model', start: null, end: null, source: 'usage' },
    ],
    receipts: [{ callId: 'call_unknown', latencyMs: 500 }],
  });
  expect(result.modelMs).toBeNull();
  expect(result.activeMachineMs).toBeNull();
  expect(result.knownIntervalUnionsMs.model).toBe(2000);
  expect(result.missingIntervals).toBe(1);
});

test('root discovery, repeated directories and optional task labels do not duplicate attempts', async () => {
  const { root } = await fixture('results.json', {
    build: 'abc1234',
    model: 'local/scripted',
    guidance: 'on',
    results: [{ task: 'arbitrary_source_key', pass: true, wall_s: 3 }],
  });
  const mapping = join(root, 'mapping.json');
  await writeFile(mapping, JSON.stringify({ arbitrary_source_key: 'Neutral task label' }));
  await mkdir(join(root, 'nested'));
  await writeFile(
    join(root, 'nested', 'results.json'),
    JSON.stringify([{ task: 'nested_task', pass: false, wall_s: null }]),
  );
  const run = Bun.spawnSync([
    'bun',
    join(import.meta.dir, 'profile.ts'),
    '--results-root',
    root,
    '--results',
    root,
    '--task-map',
    mapping,
  ]);
  expect(run.exitCode).toBe(0);
  const result = JSON.parse(run.stdout.toString());
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts.some((a: { task: string }) => a.task === 'Neutral task label')).toBe(true);
  expect(result.attempts.some((a: { task: string }) => a.task === 'nested_task')).toBe(true);
});
