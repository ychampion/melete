import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserController } from '../../src/workers/browser/controller.ts';
import type { LiveDown, LiveInput } from '../../src/workers/browser/live-protocol.ts';
import { BrowserFault } from '../../src/workers/browser/sessions.ts';
import { SIGN_IN, SIGN_IN_POINTS } from './browser-fixture.ts';

// The worker runs in Node, so a scripted person drives the live session against real Chromium
// here. Results go to a file: this process must leave stdout and stderr empty.
const [resultsPath, app, idp, other] = process.argv.slice(2);
if (!resultsPath || !app || !idp || !other) throw new Error('results path and origins required');
const result: Record<string, unknown> = {};
const reason = (error: unknown) =>
  error instanceof BrowserFault ? error.reason : error instanceof Error ? error.message : 'error';
const refusal = async (operation: () => Promise<unknown>) => {
  try {
    await operation();
    return 'accepted';
  } catch (error) {
    return reason(error);
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const controller = new BrowserController({
  spaceId: 'sp_live_session',
  spaceRoot: await mkdtemp(join(tmpdir(), 'melete-browser-live-')),
  idleMs: 1500,
  humanIdleMs: 2500,
  network: { fixtureOrigins: [app, idp, other] },
});
const { sessions, live } = controller;
try {
  let session = await sessions.lease('job_live', {
    public_compartment: false,
    allowed_domains: ['127.0.0.1'],
  });
  const command = (operation: unknown) =>
    controller.command({
      session_id: session.id,
      job_id: 'job_live',
      control_epoch: session.control_epoch,
      operation,
    });
  await command({ kind: 'observe' });
  result.agent_open = await refusal(() => command({ kind: 'open', url: `${app}/signin` }));
  const beforeTakeover = session.control_epoch;
  session = await sessions.takeover(session.id);
  result.stale_dispatch = await refusal(() =>
    sessions.dispatchHumanInput(session.id, beforeTakeover, async () => {
      result.stale_dispatch_ran = true;
    }),
  );
  result.stale_open = await refusal(() => live.open(session.id, beforeTakeover));
  const opened = await live.open(session.id, session.control_epoch);
  result.opened = { ...opened, live_id: opened.live_id.length };
  result.second_open = await refusal(() => live.open(session.id, session.control_epoch));

  let seq = 0;
  const frames: Array<{ bytes: number; at: number }> = [];
  let where = '';
  const pull = async (timeout: number) => {
    const { events } = await live.pull(opened.live_id, seq, timeout);
    for (const event of events) {
      if (event.type === 'frame') {
        seq = event.seq;
        frames.push({ bytes: event.data.length, at: performance.now() });
        result.frame ??= {
          jpeg: Buffer.from(event.data, 'base64').subarray(0, 3).toString('hex'),
          meta: event.meta,
        };
      }
      if (event.type === 'where') where = event.url;
    }
    return events;
  };
  const until = async (predicate: (events: LiveDown[]) => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) if (predicate(await pull(500))) return true;
    return false;
  };
  const send = (events: LiveInput[]) => live.input(opened.live_id, seq, events);
  const click = (point: { x: number; y: number }) =>
    send([
      { k: 'move', ...point, button: 0, mods: 0, clicks: 1 },
      { k: 'down', ...point, button: 0, mods: 0, clicks: 1 },
      { k: 'up', ...point, button: 0, mods: 0, clicks: 1 },
    ]);
  const key = (name: string, code: string, vk: number, text?: string) =>
    send([
      { k: 'key', down: true, key: name, code, vk, mods: 0, ...(text ? { text } : {}) },
      { k: 'key', down: false, key: name, code, vk, mods: 0 },
    ]);

  result.first_frame = await until((events) => events.some((event) => event.type === 'frame'));
  const clickStarted = performance.now();
  await click(SIGN_IN_POINTS.first_field);
  result.click_round_trip_ms = Math.round(performance.now() - clickStarted);
  await key('c', 'KeyC', 67, 'c');
  await key('o', 'KeyO', 79, 'o');
  await send([{ k: 'text', text: SIGN_IN.password.slice(2) }]);
  // A test-only read of the page, which the live channel itself never offers.
  result.password_field = await sessions.page?.inputValue('#password');
  await key('Enter', 'Enter', 13, '\r');
  result.reached_otp = await until(() => where.endsWith('/otp'));
  await click(SIGN_IN_POINTS.first_field);
  await send([{ k: 'text', text: SIGN_IN.code }]);
  await key('Enter', 'Enter', 13, '\r');
  result.reached_account = await until(() => where.includes('/account'));

  await click(SIGN_IN_POINTS.help);
  result.popup_followed = await until(() => where.endsWith('/help'));
  await click(SIGN_IN_POINTS.close_help);
  result.popup_closed_back = await until(() => where.includes('/account'));

  await click(SIGN_IN_POINTS.activity);
  frames.length = 0;
  const measured = performance.now();
  while (performance.now() - measured < 2000) await pull(250);
  const sizes = frames.map((frame) => frame.bytes);
  result.animated = {
    frames: frames.length,
    fps: Math.round((frames.length / ((performance.now() - measured) / 1000)) * 10) / 10,
    mean_bytes: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0,
    max_bytes: Math.max(0, ...sizes),
  };
  // Nobody pulls while the page animates: Chromium keeps sending, the channel keeps two frames.
  await sleep(1000);

  // Well past the automation idle timeout, with the person's channel in use.
  const idleStarted = Date.now();
  while (Date.now() - idleStarted < 3500) await pull(300);
  result.alive_during_takeover = Boolean(sessions.session && sessions.context);
  result.usage = live.usage();

  const staleLive = opened.live_id;
  session = await sessions.handback(session.id);
  session = await sessions.takeover(session.id);
  result.stale_channel_input = await refusal(() =>
    live.input(staleLive, 0, [{ k: 'text', text: 'must-not-arrive' }]),
  );
  result.stale_channel_pull = (await live.pull(staleLive, 0, 0)).events;
  result.stale_channel_after_end = await refusal(() => live.pull(staleLive, 0, 0));
  result.note_field = await sessions.page?.inputValue('#note');
  result.pages_after_handback = sessions.context?.pages().length;

  // No channel now: once the person's idle window passes, the idle timer may close Chromium.
  await sleep(2500 + 1500 + 1500);
  result.closed_after_human_idle = sessions.session === undefined;
} catch (error) {
  result.error = reason(error);
} finally {
  await sessions.close();
  await writeFile(resultsPath, JSON.stringify(result));
}
