/**
 * The computer tools: which desktop command an admitted payload becomes, what
 * is refused before anything reaches the desktop, and what a receipt keeps.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Action } from '@melete/contracts';
import type { DesktopCommand, DockerSandboxProvider } from '../sandbox/adapters/docker.ts';
import { MemoryComputerControls } from '../sandbox/computer-control.ts';
import type { SessionRow } from '../sandbox/sessions.ts';
import {
  COMPUTER_TOOL_NAMES,
  COMPUTER_TOOLS,
  ComputerPayloadRefusal,
  desktopCommandFor,
  desktopCommandsFor,
  HumanControlRefusal,
  MAX_BATCH_ACTIONS,
  pngSize,
  runComputerAction,
} from './sandbox-computer.ts';
import {
  sandboxDispatchBudgetMs,
  sandboxExecManifest,
  sandboxTerminalManifest,
} from './sandbox-exec.ts';
import { PROCESS_TOOL_NAMES } from './sandbox-process.ts';

const controls = new MemoryComputerControls();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const action = (kind: string, payload: Record<string, unknown>, id = 'act_COMPUTER1') =>
  ({ id, kind, canonical_payload: { step: 1, ...payload } }) as unknown as Action;

/** A PNG header of the given size, enough for pngSize and a digest. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('every computer tool is a sandbox tool the manifest offers, with the desktop only where there is one', () => {
  expect([...COMPUTER_TOOL_NAMES]).toEqual([
    'computer.screenshot',
    'computer.open',
    'computer.click',
    'computer.type',
    'computer.key',
    'computer.scroll',
    'computer.batch',
  ]);
  // Looking is a read; everything else changes the sandbox and nothing outside it.
  expect(COMPUTER_TOOLS.map((tool) => [tool.name, tool.effect_class])).toEqual([
    ['computer.screenshot', 'read'],
    ['computer.open', 'write_reversible'],
    ['computer.click', 'write_reversible'],
    ['computer.type', 'write_reversible'],
    ['computer.key', 'write_reversible'],
    ['computer.scroll', 'write_reversible'],
    ['computer.batch', 'write_reversible'],
  ]);
  for (const tool of COMPUTER_TOOLS) {
    expect(tool.required_scopes).toEqual([tool.name]);
    expect((tool.input_schema as { required: string[] }).required).toContain('step');
  }
  expect(sandboxTerminalManifest.tools.map((tool) => tool.name)).toEqual([
    'terminal.run',
    ...PROCESS_TOOL_NAMES,
  ]);
  expect(sandboxExecManifest.tools.map((tool) => tool.name)).toEqual([
    'terminal.run',
    ...PROCESS_TOOL_NAMES,
    ...COMPUTER_TOOL_NAMES,
  ]);
  expect(
    sandboxDispatchBudgetMs({ kind: 'computer.open', canonical_payload: {} } as never),
  ).toBeGreaterThan(120_000);
  // Every step of the longest batch, and the screenshot after it.
  expect(
    sandboxDispatchBudgetMs({ kind: 'computer.batch', canonical_payload: {} } as never),
  ).toBeGreaterThan(60_000 * (MAX_BATCH_ACTIONS + 1));
});

test('admitted payloads become desktop commands', () => {
  const cases: [string, Record<string, unknown>, DesktopCommand][] = [
    ['computer.screenshot', {}, { kind: 'screenshot' }],
    [
      'computer.open',
      { url: 'https://example.com/' },
      { kind: 'open', url: 'https://example.com/' },
    ],
    ['computer.click', { x: 5, y: 6 }, { kind: 'click', x: 5, y: 6, button: 1, count: 1 }],
    [
      'computer.click',
      { x: 1023, y: 767, button: 'right', clicks: 2 },
      { kind: 'click', x: 1023, y: 767, button: 3, count: 2 },
    ],
    ['computer.type', { text: 'hello' }, { kind: 'type', text: 'hello' }],
    ['computer.key', { keys: ['ctrl+l', 'Return'] }, { kind: 'key', keys: ['ctrl+l', 'Return'] }],
    ['computer.scroll', { x: 1, y: 2, amount: -4 }, { kind: 'scroll', x: 1, y: 2, dy: -4 }],
  ];
  for (const [kind, payload, command] of cases)
    expect(desktopCommandFor(action(kind, payload))).toEqual(command);
});

test('a payload that is not a computer action is refused before the desktop is asked', () => {
  for (const [kind, payload] of [
    ['computer.screenshot', { step: 0 }],
    ['computer.open', { url: 'file:///etc/passwd' }],
    ['computer.open', { url: 42 }],
    ['computer.click', { x: 1024, y: 0 }],
    ['computer.click', { x: 1, y: 1, button: 'back' }],
    ['computer.click', { x: 1, y: 1, clicks: 4 }],
    ['computer.type', { text: '' }],
    ['computer.type', { text: 'x'.repeat(4097) }],
    ['computer.key', { keys: ['Return', 'rm -rf'] }],
    ['computer.key', { keys: 'Return' }],
    ['computer.scroll', { x: 1, y: 1, amount: 0 }],
    ['terminal.run', { command: 'true' }],
  ] as const)
    expect(() => desktopCommandFor(action(kind, payload))).toThrow(ComputerPayloadRefusal);
});

test('a batch becomes its steps in order, and one refused step refuses it whole', () => {
  expect(
    desktopCommandsFor(
      action('computer.batch', {
        actions: [
          { action: 'click', x: 10, y: 20 },
          { action: 'type', text: 'Dana Reyes' },
          { action: 'key', keys: ['Tab'] },
          { action: 'open', url: 'https://example.com/' },
          { action: 'scroll', x: 1, y: 2, amount: 3 },
        ],
      }),
    ),
  ).toEqual([
    { kind: 'click', x: 10, y: 20, button: 1, count: 1 },
    { kind: 'type', text: 'Dana Reyes' },
    { kind: 'key', keys: ['Tab'] },
    { kind: 'open', url: 'https://example.com/' },
    { kind: 'scroll', x: 1, y: 2, dy: 3 },
  ]);
  // A single action is one command.
  expect(desktopCommandsFor(action('computer.key', { keys: ['Return'] }))).toEqual([
    { kind: 'key', keys: ['Return'] },
  ]);
  for (const actions of [
    [],
    Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ action: 'key', keys: ['Tab'] })),
    [{ action: 'screenshot' }],
    [{ action: 'batch', actions: [] }],
    [{ x: 1, y: 1 }],
    ['click'],
    [
      { action: 'click', x: 1, y: 1 },
      { action: 'open', url: 'file:///etc/passwd' },
    ],
  ])
    expect(() => desktopCommandsFor(action('computer.batch', { actions }))).toThrow(
      ComputerPayloadRefusal,
    );
  expect(() =>
    desktopCommandsFor(
      action('computer.batch', {
        actions: [
          { action: 'click', x: 1, y: 1 },
          { action: 'type', text: '' },
        ],
      }),
    ),
  ).toThrow('step 2 of the batch');
});

test('a PNG header is read for its size; anything else is not an image', () => {
  expect(pngSize(png(1024, 768))).toEqual({ width: 1024, height: 768 });
  expect(pngSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  expect(pngSize(new Uint8Array(30))).toBeNull();
});

function fixture(answers: Partial<Record<DesktopCommand['kind'], Uint8Array>> = {}) {
  const sandbox = `melete-sbx-test-${Math.random().toString(36).slice(2)}`;
  const seen: DesktopCommand[] = [];
  const provider = {
    desktop: true,
    async computer(_handle: unknown, command: DesktopCommand) {
      seen.push(command);
      return (
        answers[command.kind] ??
        new TextEncoder().encode('{"window":"Example - Chromium","browser":true}')
      );
    },
  } as unknown as DockerSandboxProvider;
  const session = {
    id: 'sbx_TEST',
    providerSandboxId: sandbox,
    imageDigest: null,
    region: null,
  } as unknown as SessionRow;
  return { sandbox, seen, provider, session };
}

async function workRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'melete-computer-'));
  roots.push(root);
  return root;
}

test('a screenshot is kept in the job workspace and the receipt says where, how big and what it is', async () => {
  const { provider, session, seen } = fixture({ screenshot: png(1024, 768) });
  const root = await workRoot();
  const detail = await runComputerAction({
    action: action('computer.screenshot', {}, 'act_SHOT1'),
    jobId: 'job_COMPUTER',
    workRoot: root,
    session,
    provider,
    controls,
    signal: AbortSignal.timeout(5_000),
  });
  expect(detail).toMatchObject({
    computer: 'screenshot',
    session_id: 'sbx_TEST',
    path: '.melete/computer/act_SHOT1.png',
    width: 1024,
    height: 768,
    bytes: 64,
    window: 'Example - Chromium',
    browser: true,
    control_epoch: 0,
  });
  expect(detail.sha256).toMatch(/^[a-f0-9]{64}$/);
  const kept = await readFile(
    path.join(root, 'job_COMPUTER', '.melete', 'computer', 'act_SHOT1.png'),
  );
  expect(kept.byteLength).toBe(64);
  expect(seen.map((command) => command.kind)).toEqual(['screenshot', 'info']);
});

test('a screenshot that is not an image is an error, not a receipt', async () => {
  const { provider, session } = fixture({ screenshot: new TextEncoder().encode('not a png') });
  await expect(
    runComputerAction({
      action: action('computer.screenshot', {}),
      jobId: 'job_COMPUTER',
      workRoot: await workRoot(),
      session,
      provider,
      controls,
      signal: AbortSignal.timeout(5_000),
    }),
  ).rejects.toThrow('did not answer with an image');
});

test('while a person holds the computer every agent action is refused, and after hand-back it is not', async () => {
  const { provider, session, sandbox, seen } = fixture();
  const run = () =>
    runComputerAction({
      action: action('computer.click', { x: 10, y: 10 }),
      jobId: 'job_COMPUTER',
      workRoot: '/nowhere',
      session,
      provider,
      controls,
      signal: AbortSignal.timeout(5_000),
    });
  await controls.change(sandbox, 'human');
  await expect(run()).rejects.toBeInstanceOf(HumanControlRefusal);
  expect(seen).toEqual([]);
  const back = await controls.change(sandbox, 'agent');
  expect(await run()).toMatchObject({ computer: 'click', control_epoch: back?.epoch });
});

test('a takeover that lands while an action runs is said so in its receipt', async () => {
  const { session, sandbox } = fixture();
  const provider = {
    desktop: true,
    async computer() {
      await controls.change(sandbox, 'human');
      return new TextEncoder().encode('{}');
    },
  } as unknown as DockerSandboxProvider;
  const detail = await runComputerAction({
    action: action('computer.type', { text: 'hi' }),
    jobId: 'job_COMPUTER',
    workRoot: '/nowhere',
    session,
    provider,
    controls,
    signal: AbortSignal.timeout(5_000),
  });
  expect(detail.control_changed).toBe(true);
});

test('every step ends with a screenshot kept in the job workspace, so the agent need not ask for one', async () => {
  const { provider, session, seen } = fixture({
    screenshot: png(1024, 768),
    click: new TextEncoder().encode('{"window":"Form - Chromium"}'),
  });
  const root = await workRoot();
  const detail = await runComputerAction({
    action: action('computer.click', { x: 10, y: 20 }, 'act_CLICK1'),
    jobId: 'job_COMPUTER',
    workRoot: root,
    session,
    provider,
    controls,
    signal: AbortSignal.timeout(5_000),
    settleMs: 0,
  });
  expect(detail).toMatchObject({
    computer: 'click',
    window: 'Form - Chromium',
    path: '.melete/computer/act_CLICK1.png',
    width: 1024,
    height: 768,
  });
  expect(detail.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(seen.map((command) => command.kind)).toEqual(['click', 'screenshot']);
  const kept = await readFile(
    path.join(root, 'job_COMPUTER', '.melete', 'computer', 'act_CLICK1.png'),
  );
  expect(kept.byteLength).toBe(64);
});

test('a screenshot that fails after a step never turns the step that happened into a failure', async () => {
  const { provider, session } = fixture({ screenshot: new TextEncoder().encode('not a png') });
  const detail = await runComputerAction({
    action: action('computer.type', { text: 'hi' }),
    jobId: 'job_COMPUTER',
    workRoot: await workRoot(),
    session,
    provider,
    controls,
    signal: AbortSignal.timeout(5_000),
    settleMs: 0,
  });
  expect(detail.computer).toBe('type');
  expect(detail.path).toBeUndefined();
  expect(detail.screenshot).toBe('not taken: the desktop did not answer with an image');
});

test('a batch runs its steps in order and looks once, after the last', async () => {
  const { provider, session, seen } = fixture({ screenshot: png(1024, 768) });
  const detail = await runComputerAction({
    action: action(
      'computer.batch',
      {
        actions: [
          { action: 'click', x: 10, y: 20 },
          { action: 'type', text: 'Dana Reyes' },
          { action: 'key', keys: ['Tab'] },
        ],
      },
      'act_BATCH1',
    ),
    jobId: 'job_COMPUTER',
    workRoot: await workRoot(),
    session,
    provider,
    controls,
    signal: AbortSignal.timeout(5_000),
    settleMs: 0,
  });
  expect(seen.map((command) => command.kind)).toEqual(['click', 'type', 'key', 'screenshot']);
  expect(detail).toMatchObject({
    computer: 'batch',
    completed: 3,
    requested: 3,
    path: '.melete/computer/act_BATCH1.png',
  });
  expect((detail.steps as { computer: string }[]).map((step) => step.computer)).toEqual([
    'click',
    'type',
    'key',
  ]);
  expect(detail.stopped).toBeUndefined();
});

test('a batch stops at the first step that fails and says which, still showing the screen', async () => {
  const { session } = fixture();
  const seen: string[] = [];
  const provider = {
    desktop: true,
    async computer(_handle: unknown, command: DesktopCommand) {
      seen.push(command.kind);
      if (command.kind === 'screenshot') return png(1024, 768);
      if (command.kind === 'type') throw new Error('xdotool exited 1');
      return new TextEncoder().encode('{}');
    },
  } as unknown as DockerSandboxProvider;
  const root = await workRoot();
  const run = (actions: unknown[]) =>
    runComputerAction({
      action: action('computer.batch', { actions }),
      jobId: 'job_COMPUTER',
      workRoot: root,
      session,
      provider,
      controls,
      signal: AbortSignal.timeout(5_000),
      settleMs: 0,
    });
  const detail = await run([
    { action: 'click', x: 1, y: 1 },
    { action: 'type', text: 'x' },
    { action: 'key', keys: ['Return'] },
  ]);
  expect(seen).toEqual(['click', 'type', 'screenshot']);
  expect(detail).toMatchObject({ completed: 1, requested: 3 });
  expect(detail.stopped).toContain('step 2 (type) failed: xdotool exited 1');
  expect(detail.path).toBe('.melete/computer/act_COMPUTER1.png');
  // The first step failing is the action failing, as for a single step.
  await expect(run([{ action: 'type', text: 'x' }])).rejects.toThrow('xdotool exited 1');
});

test('a person who takes the computer during a batch stops the rest, and nothing is captured', async () => {
  const { session, sandbox } = fixture();
  const seen: string[] = [];
  const provider = {
    desktop: true,
    async computer(_handle: unknown, command: DesktopCommand) {
      seen.push(command.kind);
      if (command.kind === 'click') await controls.change(sandbox, 'human');
      return new TextEncoder().encode('{}');
    },
  } as unknown as DockerSandboxProvider;
  const detail = await runComputerAction({
    action: action('computer.batch', {
      actions: [
        { action: 'click', x: 1, y: 1 },
        { action: 'type', text: 'secret' },
      ],
    }),
    jobId: 'job_COMPUTER',
    workRoot: '/nowhere',
    session,
    provider,
    controls,
    signal: AbortSignal.timeout(5_000),
    settleMs: 0,
  });
  expect(seen).toEqual(['click']);
  expect(detail).toMatchObject({ completed: 1, control_changed: true });
  expect(detail.stopped).toContain('a person took control');
  expect(detail.screenshot).toBe('not taken: a person took control');
});
