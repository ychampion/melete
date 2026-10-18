/**
 * The computer tools on a Maritime computer: which providers have a desktop,
 * what each tool becomes as Maritime actions, how positions follow the frame
 * of the last screenshot, what is refused in plain words, and that a Docker
 * computer is driven exactly as before.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Action, SANDBOX_ADAPTER_DESKTOP, SANDBOX_ADAPTERS } from '@melete/contracts';
import { DOCKER_DESKTOP, type DockerSandboxProvider } from '../sandbox/adapters/docker.ts';
import { createMaritimeProvider } from '../sandbox/adapters/maritime.ts';
import { AUTHORING_KEY, createMaritimeStandin } from '../sandbox/adapters/maritime-standin.ts';
import { SANDBOX_ADAPTER_PLUGINS } from '../sandbox/adapters/registry.ts';
import { MemoryComputerControls } from '../sandbox/computer-control.ts';
import { FAKE_CAPABILITIES } from '../sandbox/fake.ts';
import { openSandbox, sandboxLabels } from '../sandbox/manifest.ts';
import type { SessionRow } from '../sandbox/sessions.ts';
import type { SandboxProvider, SandboxSpec } from '../sandbox/types.ts';
import {
  COMPUTER_TOOLS,
  ComputerPayloadRefusal,
  computerToolsOf,
  desktopCommandsFor,
  runComputerAction,
} from './sandbox-computer.ts';
import {
  desktopOf,
  MARITIME_DESKTOP,
  MARITIME_HELD,
  noDesktop,
  scaledPoint,
} from './sandbox-desktop.ts';
import {
  sandboxExecManifest,
  sandboxManifestFor,
  sandboxTerminalManifest,
} from './sandbox-exec.ts';

const signal = () => AbortSignal.timeout(30_000);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const action = (kind: string, payload: Record<string, unknown>, id = 'act_MDESK1') =>
  ({ id, kind, canonical_payload: { step: 1, ...payload } }) as unknown as Action;

const spec = (): SandboxSpec => ({
  image: 'linux',
  egress: { kind: 'open' },
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({ project: 'mdesk-test', space: 'sp_MDESK', session: 'sbx_MDESK' }),
  env: {},
});

/** A Maritime computer on the stand-in, with the desktop the tools drive. */
async function maritime() {
  const standin = createMaritimeStandin();
  const provider = createMaritimeProvider({
    credential: (use) => use(AUTHORING_KEY),
    fetch: standin.fetch,
    graceMs: 1_500,
  });
  const handle = await openSandbox(provider, spec(), signal());
  // The touch that wakes it when it is made is not one of the tools' actions.
  standin.acted.length = 0;
  // Screenshots at Maritime's own size, as on a real computer.
  standin.frame(MARITIME_DESKTOP.width, MARITIME_DESKTOP.height);
  const desktop = desktopOf(provider);
  if (!desktop) throw new Error('a Maritime computer has a desktop');
  const session = {
    id: 'sbx_MDESK',
    providerSandboxId: handle.providerSandboxId,
    imageDigest: null,
    region: null,
  } as unknown as SessionRow;
  const root = await mkdtemp(path.join(tmpdir(), 'melete-mdesk-'));
  roots.push(root);
  const controls = new MemoryComputerControls();
  const run = (kind: string, payload: Record<string, unknown>, id?: string) =>
    runComputerAction({
      action: action(kind, payload, id),
      jobId: 'job_MDESK',
      workRoot: root,
      session,
      provider: desktop,
      controls,
      signal: signal(),
      settleMs: 0,
      challengeWaitMs: 0,
    });
  const actedHere = () =>
    standin.acted
      .filter((each) => each.id === handle.providerSandboxId)
      .flatMap((each) => each.actions);
  return { standin, provider, handle, desktop, session, controls, run, actedHere };
}

test('each adapter says whether its computers have a desktop, as the connection form does', () => {
  for (const adapter of SANDBOX_ADAPTERS)
    expect([adapter, SANDBOX_ADAPTER_PLUGINS[adapter].capabilities('hobby').desktop]).toEqual([
      adapter,
      SANDBOX_ADAPTER_DESKTOP[adapter],
    ]);
  // A provider without one is offered the terminal alone and no desktop driver.
  const plain = { capabilities: { ...FAKE_CAPABILITIES, adapter: 'e2b' } } as SandboxProvider;
  expect(desktopOf(plain)).toBeNull();
  expect(sandboxManifestFor(plain)).toBe(sandboxTerminalManifest);
});

test('a Docker computer keeps its own desktop, tools and manifest unchanged', () => {
  const docker = {
    desktop: true,
    capabilities: { ...FAKE_CAPABILITIES, adapter: 'docker', desktop: true },
    async computer() {
      return new Uint8Array();
    },
  } as unknown as DockerSandboxProvider;
  expect(desktopOf(docker)).toBe(docker);
  expect(sandboxManifestFor(docker)).toBe(sandboxExecManifest);
  expect(computerToolsOf(docker)).toBe(COMPUTER_TOOLS);
  const click = COMPUTER_TOOLS.find((tool) => tool.name === 'computer.click');
  expect(click?.description).toContain(`${DOCKER_DESKTOP.width}x${DOCKER_DESKTOP.height}`);
});

test('a Maritime computer is offered its screen and only the tools it can carry out', async () => {
  const { provider, desktop } = await maritime();
  const manifest = sandboxManifestFor(provider);
  const names = manifest.tools.map((tool) => tool.name);
  expect(names).toContain('terminal.run');
  expect(names.filter((name) => name.startsWith('computer.'))).toEqual([
    'computer.screenshot',
    'computer.click',
    'computer.type',
    'computer.key',
    'computer.scroll',
    'computer.batch',
  ]);
  const tools = computerToolsOf(desktop);
  const click = tools.find((tool) => tool.name === 'computer.click');
  expect(click?.description).toContain('The screen is 1200x750');
  if (!click) throw new Error('a Maritime computer is offered computer.click');
  const fields = (click.input_schema as { properties: Record<string, { maximum: number }> })
    .properties;
  expect(fields.x?.maximum).toBe(1199);
  expect(fields.y?.maximum).toBe(749);
  const batch = tools.find((tool) => tool.name === 'computer.batch');
  expect(JSON.stringify(batch?.input_schema)).not.toContain('"open"');
  expect(tools.find((tool) => tool.name === 'computer.screenshot')?.description).toContain(
    'does not give its screen as text',
  );
  // Positions are checked against Maritime's screen, not Docker's.
  const desk = { screen: MARITIME_DESKTOP, opens: false };
  expect(desktopCommandsFor(action('computer.click', { x: 1150, y: 740 }), desk)).toEqual([
    { kind: 'click', x: 1150, y: 740, button: 1, count: 1 },
  ]);
  expect(() => desktopCommandsFor(action('computer.click', { x: 1200, y: 0 }), desk)).toThrow(
    ComputerPayloadRefusal,
  );
  expect(() =>
    desktopCommandsFor(action('computer.open', { url: 'https://example.com' }), desk),
  ).toThrow('cannot open an address by itself');
  expect(() =>
    desktopCommandsFor(
      action('computer.batch', { actions: [{ action: 'open', url: 'https://example.com' }] }),
      desk,
    ),
  ).toThrow('one of click, type, key, scroll');
});

test('each tool runs as Maritime actions without their own screenshot, and ends with one', async () => {
  const m = await maritime();
  const clicked = await m.run('computer.click', { x: 100, y: 200, clicks: 2 }, 'act_CLICK');
  expect(clicked).toMatchObject({
    computer: 'click',
    session_id: 'sbx_MDESK',
    sandbox_id: m.handle.providerSandboxId,
    control_epoch: 0,
    path: '.melete/computer/act_CLICK.png',
    screen_text: {
      unavailable: 'this computer does not give its screen as text; read the screenshot',
    },
  });
  await m.run('computer.type', { text: 'hello' });
  await m.run('computer.key', { keys: ['ctrl+a', 'Return'] });
  await m.run('computer.scroll', { x: 10, y: 20, amount: -3 });
  await m.run('computer.batch', {
    actions: [
      { action: 'click', x: 5, y: 6, button: 'right' },
      { action: 'type', text: 'x' },
    ],
  });
  expect(m.actedHere()).toEqual([
    { action: 'double_click', coordinate: [100, 200], noScreenshot: true },
    { action: 'type', text: 'hello', noScreenshot: true },
    { action: 'key', text: 'ctrl+a', noScreenshot: true },
    { action: 'key', text: 'Return', noScreenshot: true },
    {
      action: 'scroll',
      coordinate: [10, 20],
      scrollDirection: 'up',
      scrollAmount: 3,
      noScreenshot: true,
    },
    { action: 'right_click', coordinate: [5, 6], noScreenshot: true },
    { action: 'type', text: 'x', noScreenshot: true },
  ]);
  await m.provider.destroy(m.handle, signal());
});

test('a screenshot is kept as a PNG, and later positions follow the frame it was taken in', async () => {
  const m = await maritime();
  // The frame Maritime takes positions in is its default: positions go through as given.
  m.standin.frame(1200, 750);
  const shot = await m.run('computer.screenshot', {}, 'act_SHOT');
  expect(shot).toMatchObject({ computer: 'screenshot', width: 1200, height: 750, bytes: 64 });
  expect(shot).not.toHaveProperty('window');
  await m.run('computer.click', { x: 1199, y: 749 });
  // A computer whose screenshots come back at half the size takes half the position.
  m.standin.frame(600, 375);
  expect(await m.run('computer.screenshot', {}, 'act_SHOT2')).toMatchObject({
    width: 600,
    height: 375,
  });
  await m.run('computer.click', { x: 1199, y: 749 });
  await m.run('computer.scroll', { x: 600, y: 375, amount: 2 });
  expect(m.actedHere().map((each) => each.coordinate)).toEqual([
    [1199, 749],
    [599, 374],
    // The centre of tool pixel (600, 375) is at (300.25, 187.75) in the half-size frame.
    [300, 187],
  ]);
  expect(scaledPoint(0, 0, MARITIME_DESKTOP, { width: 600, height: 375 })).toEqual([0, 0]);
  expect(scaledPoint(1199, 749, MARITIME_DESKTOP, MARITIME_DESKTOP)).toEqual([1199, 749]);
  await m.provider.destroy(m.handle, signal());
});

test('a position scaled to another frame lands on the pixel holding its centre, edges included', () => {
  // The reference: the destination pixel whose span holds the source pixel's centre, found by search.
  const reference = (value: number, a: number, b: number) => {
    for (let pixel = 0; pixel < b; pixel += 1)
      if (2 * pixel * a <= (2 * value + 1) * b && (2 * value + 1) * b < 2 * (pixel + 1) * a)
        return pixel;
    throw new Error('no pixel holds it');
  };
  const frames = [
    { width: 1200, height: 750 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1200 },
    { width: 2400, height: 1500 },
    { width: 600, height: 375 },
    { width: 1199, height: 749 },
    { width: 1201, height: 751 },
    { width: 1, height: 1 },
    { width: 3841, height: 2161 },
  ];
  let seed = 7;
  const random = (below: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % below;
  };
  for (let each = 0; each < 40; each += 1)
    frames.push({ width: 1 + random(4000), height: 1 + random(2500) });
  for (const to of frames) {
    const xs = [
      0,
      1,
      2,
      598,
      599,
      600,
      1197,
      1198,
      1199,
      ...Array.from({ length: 40 }, () => random(1200)),
    ];
    const ys = [0, 1, 374, 375, 748, 749, ...Array.from({ length: 40 }, () => random(750))];
    for (const [index, x] of xs.entries()) {
      const y = ys[index % ys.length] as number;
      const [sx, sy] = scaledPoint(x, y, MARITIME_DESKTOP, to);
      expect([to, x, y, sx, sy]).toEqual([
        to,
        x,
        y,
        reference(x, MARITIME_DESKTOP.width, to.width),
        reference(y, MARITIME_DESKTOP.height, to.height),
      ]);
    }
    // The edges, checked against the reference above, never land outside the frame.
    const [lx, ly] = scaledPoint(1199, 749, MARITIME_DESKTOP, to);
    expect([lx < to.width, ly < to.height]).toEqual([true, true]);
  }
});

test('a person holding the desktop in its viewer refuses the step in a plain sentence', async () => {
  const m = await maritime();
  m.standin.hold(m.handle.providerSandboxId);
  const refused = await m.run('computer.click', { x: 1, y: 1 }).catch((error: unknown) => error);
  expect((refused as Error).message).toBe(MARITIME_HELD);
  expect(m.actedHere()).toEqual([]);
  // Taken over in the app, nothing is sent at all, as on Docker.
  m.standin.hold(m.handle.providerSandboxId, false);
  const key = m.session.providerSandboxId;
  const from = (await m.controls.state(key)).epoch;
  await m.controls.change(key, 'human', { from });
  await expect(m.run('computer.type', { text: 'no' })).rejects.toThrow(
    'a person has taken control of this computer',
  );
  expect(m.actedHere()).toEqual([]);
  await m.provider.destroy(m.handle, signal());
});

test('what Maritime has no command for is refused before anything is sent', async () => {
  const m = await maritime();
  for (const command of [
    { kind: 'open', url: 'https://example.com' },
    { kind: 'text' },
    { kind: 'input', events: [] },
  ] as const)
    await expect(m.desktop.computer(m.handle, command, signal())).rejects.toThrow(
      /^this|^a person/,
    );
  expect(
    JSON.parse(
      new TextDecoder().decode(await m.desktop.computer(m.handle, { kind: 'info' }, signal())),
    ),
  ).toEqual({});
  expect(m.actedHere()).toEqual([]);
  await m.provider.destroy(m.handle, signal());
});

test('a provider without a desktop is refused in a plain sentence', () => {
  expect(noDesktop('e2b')).toBe(
    'This computer has no screen to see or use: E2B computers run commands only. Use the terminal tools instead.',
  );
  expect(noDesktop('modal')).toContain('Modal computers run commands only');
});
