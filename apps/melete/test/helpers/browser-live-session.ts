import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserController } from '../../src/workers/browser/controller.ts';
import type { BrowserLive } from '../../src/workers/browser/live.ts';
import type { LiveDown, LiveInput } from '../../src/workers/browser/live-protocol.ts';
import { BrowserFault, type BrowserSession } from '../../src/workers/browser/sessions.ts';
import { SIGN_IN, SIGN_IN_POINTS } from './browser-fixture.ts';

// The worker runs in Node, so a scripted person drives the live session against real Chromium
// here. Results go to a file: this process must leave stdout and stderr empty.
const [resultsPath = '', mode = '', app = '', idp = '', other = ''] = process.argv.slice(2);
if (!resultsPath || !mode || !app || !idp || !other) throw new Error('arguments are required');
const result: Record<string, unknown> = {};
// Progress is written as it happens, so a run stopped by a timeout still shows where it was.
const mark = (step: string) => {
  result.step = step;
  return writeFile(resultsPath, JSON.stringify(result));
};
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
const policy = { public_compartment: false, allowed_domains: ['127.0.0.1'] };

/** One person's view of one live channel: pulls, acknowledges and remembers what came down. */
function person(live: BrowserLive, liveId: string) {
  const view = {
    seq: 0,
    where: '',
    frames: [] as Array<{ bytes: number; at: number }>,
    notices: [] as LiveDown[],
    ended: undefined as string | undefined,
    firstFrame: undefined as unknown,
  };
  const pull = async (timeout: number) => {
    const { events } = await live.pull(liveId, view.seq, timeout);
    for (const event of events) {
      if (event.type === 'frame') {
        view.seq = event.seq;
        view.frames.push({ bytes: event.data.length, at: performance.now() });
        view.firstFrame ??= {
          jpeg: Buffer.from(event.data, 'base64').subarray(0, 3).toString('hex'),
          meta: event.meta,
        };
      }
      if (event.type === 'where') view.where = event.url;
      if (event.type === 'notice') view.notices.push(event);
      if (event.type === 'ended') view.ended = event.code;
    }
    return events;
  };
  const until = async (predicate: () => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !predicate() && !view.ended) await pull(250);
    return predicate();
  };
  const pullFor = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !view.ended)
      await pull(Math.max(0, Math.min(250, deadline - Date.now())));
  };
  const send = (events: LiveInput[]) => live.input(liveId, view.seq, events);
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
  const noticed = (code: string) =>
    view.notices.some((notice) => notice.type === 'notice' && notice.code === code);
  return { view, pull, until, pullFor, send, click, key, noticed };
}

async function flow() {
  const controller = new BrowserController({
    spaceId: 'sp_live_session',
    spaceRoot: await mkdtemp(join(tmpdir(), 'melete-browser-live-')),
    idleMs: 1500,
    humanIdleMs: 2500,
    network: { fixtureOrigins: [app, idp, other] },
  });
  const { sessions, live } = controller;
  try {
    let session: BrowserSession = await sessions.lease('job_live', policy);
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
    const you = person(live, opened.live_id);

    result.first_frame = await you.until(() => you.view.frames.length > 0);
    result.frame = you.view.firstFrame;
    const clickStarted = performance.now();
    await you.click(SIGN_IN_POINTS.first_field);
    result.click_round_trip_ms = Math.round(performance.now() - clickStarted);
    await you.key('c', 'KeyC', 67, 'c');
    await you.key('o', 'KeyO', 79, 'o');
    await you.send([{ k: 'text', text: SIGN_IN.password.slice(2) }]);
    // A test-only read of the page, which the live channel itself never offers.
    result.password_field = await sessions.page?.inputValue('#password');
    await you.key('Enter', 'Enter', 13, '\r');
    result.reached_otp = await you.until(() => you.view.where.endsWith('/otp'));
    await you.click(SIGN_IN_POINTS.first_field);
    await you.send([{ k: 'text', text: SIGN_IN.code }]);
    await you.key('Enter', 'Enter', 13, '\r');
    await mark('signed in');
    result.reached_account = await you.until(() => you.view.where.includes('/account'));
    await you.pullFor(1000);

    await you.send([
      { k: 'touch', phase: 'start', points: [{ id: 1, x: 900, y: 740 }] },
      { k: 'touch', phase: 'end', points: [] },
      { k: 'wheel', x: 900, y: 740, dx: 0, dy: 120, mods: 0 },
    ]);
    await you.click(SIGN_IN_POINTS.socket);
    await mark('websocket');
    result.websocket_notice = await you.until(() => you.noticed('websocket_refused'));

    await you.click(SIGN_IN_POINTS.help);
    result.popup_followed = await you.until(() => you.view.where.endsWith('/help?n=1'));
    await you.click(SIGN_IN_POINTS.close_help);
    result.popup_closed_back = await you.until(() => you.view.where.includes('/account'));
    await you.click(SIGN_IN_POINTS.two_popups);
    result.two_popups_first_followed = await you.until(() =>
      you.view.where.endsWith('/help?two=1'),
    );
    await you.pullFor(300);
    result.two_popups_notice = you.noticed('popup_limit');
    await you.click(SIGN_IN_POINTS.close_help);
    await you.until(() => you.view.where.includes('/account'));
    for (let n = 2; n <= 7; n++) {
      await you.click(SIGN_IN_POINTS.help);
      await you.until(() => you.view.where.endsWith(`/help?n=${n}`));
      await you.click(SIGN_IN_POINTS.close_help);
      await you.until(() => you.view.where.includes('/account'));
    }
    await mark('popups');
    result.popups_before_limit = live.usage().popups;
    await you.click(SIGN_IN_POINTS.help);
    await you.pullFor(1500);
    result.ninth_popup = {
      where: you.view.where,
      pages: sessions.context?.pages().length,
      popups: live.usage().popups,
    };

    await you.click(SIGN_IN_POINTS.activity);
    await you.pullFor(300);
    you.view.frames.length = 0;
    const measured = performance.now();
    await you.pullFor(5000);
    const seconds = (performance.now() - measured) / 1000;
    const sizes = you.view.frames.map((frame) => frame.bytes);
    const bytes = sizes.reduce((a, b) => a + b, 0);
    result.animated = {
      frames: sizes.length,
      seconds: Math.round(seconds * 100) / 100,
      fps: Math.round((sizes.length / seconds) * 10) / 10,
      mean_bytes: sizes.length ? Math.round(bytes / sizes.length) : 0,
      bytes_per_second: Math.round(bytes / seconds),
      ended: you.view.ended ?? null,
      still_accepts_input: await refusal(() =>
        you.send([{ k: 'move', x: 900, y: 740, button: 0, mods: 0, clicks: 1 }]),
      ),
    };
    // Nobody pulls while the page animates: Chromium keeps sending, the channel keeps two frames.
    await sleep(1000);

    // Well past the automation idle timeout, with the person's channel in use.
    await you.pullFor(3500);
    await mark('idle');
    result.alive_during_takeover = Boolean(sessions.session && sessions.context);
    result.usage = live.usage();

    session = await sessions.handback(session.id);
    session = await sessions.takeover(session.id);
    result.stale_channel_input = await refusal(() =>
      live.input(opened.live_id, 0, [{ k: 'text', text: 'must-not-arrive' }]),
    );
    result.stale_channel_pull = (await live.pull(opened.live_id, 0, 0)).events;
    result.stale_channel_after_end = await refusal(() => live.pull(opened.live_id, 0, 0));
    result.note_field = await sessions.page?.inputValue('#note');
    result.pages_after_handback = sessions.context?.pages().length;

    const again = await live.open(session.id, session.control_epoch);
    const next = person(live, again.live_id);
    await next.until(() => next.view.where.includes('/account'));
    await next.click(SIGN_IN_POINTS.loop);
    await mark('loop');
    result.loop_notice = await next.until(() => next.noticed('redirect_refused'), 15_000);
    await next.pullFor(500);
    await live.close(again.live_id);

    // No channel now: once the person's idle window passes, the idle timer may close Chromium.
    await sleep(2500 + 1500 + 1500);
    result.closed_after_human_idle = sessions.session === undefined;
  } finally {
    await sessions.close();
  }
}

async function limits() {
  const controller = new BrowserController({
    spaceId: 'sp_live_limits',
    spaceRoot: await mkdtemp(join(tmpdir(), 'melete-browser-limits-')),
    network: { fixtureOrigins: [app, idp, other] },
    live: { limits: { takeover_ms: 3500, requests_per_takeover: 4, frame_bytes_per_second: 2000 } },
  });
  const { sessions, live } = controller;
  try {
    let session: BrowserSession = await sessions.lease('job_limits', policy);
    const command = (operation: unknown) =>
      controller.command({
        session_id: session.id,
        job_id: 'job_limits',
        control_epoch: session.control_epoch,
        operation,
      });
    await command({ kind: 'observe' });
    await command({ kind: 'open', url: `${app}/busy` });

    session = await sessions.takeover(session.id);
    const openedAt = Date.now();
    const first = await live.open(session.id, session.control_epoch);
    const you = person(live, first.live_id);
    await you.pullFor(2000);
    await mark('frame budget');
    result.frame_budget = {
      frames: you.view.frames.length,
      bytes: you.view.frames.reduce((total, frame) => total + frame.bytes, 0),
      largest: Math.max(0, ...you.view.frames.map((frame) => frame.bytes)),
      ended: you.view.ended ?? null,
    };
    await you.until(() => Boolean(you.view.ended), 4000);
    result.cap = {
      ended: you.view.ended ?? null,
      after_ms: Date.now() - openedAt,
      control: sessions.session?.control,
      reopen: await refusal(() => live.open(session.id, session.control_epoch)),
    };

    session = await sessions.handback(session.id);
    session = await sessions.takeover(session.id);
    const second = await live.open(session.id, session.control_epoch);
    const next = person(live, second.live_id);
    await next.until(() => next.view.where.endsWith('/busy'));
    await next.click(SIGN_IN_POINTS.busy_reload);
    await next.until(() => Boolean(next.view.ended), 3000);
    result.network_budget = {
      noticed: next.noticed('live_budget'),
      ended: next.view.ended ?? null,
      requests: live.usage().requests,
    };
  } finally {
    await sessions.close();
  }
}

/** A page that repaints constantly without changing a pixel of its JPEG frames. */
async function still() {
  const controller = new BrowserController({
    spaceId: 'sp_live_still',
    spaceRoot: await mkdtemp(join(tmpdir(), 'melete-browser-still-')),
    network: { fixtureOrigins: [app, idp, other] },
  });
  const { sessions, live } = controller;
  try {
    let session: BrowserSession = await sessions.lease('job_still', policy);
    const command = (operation: unknown) =>
      controller.command({
        session_id: session.id,
        job_id: 'job_still',
        control_epoch: session.control_epoch,
        operation,
      });
    await command({ kind: 'observe' });
    await command({ kind: 'open', url: `${app}/flicker` });
    session = await sessions.takeover(session.id);
    const opened = await live.open(session.id, session.control_epoch);
    const you = person(live, opened.live_id);
    await you.pullFor(500);
    const before = live.usage();
    you.view.frames.length = 0;
    await you.pullFor(2000);
    result.still = {
      received: live.usage().received_frames - before.received_frames,
      delivered: you.view.frames.length,
    };
  } finally {
    await sessions.close();
  }
}

try {
  await (mode === 'limits' ? limits() : mode === 'still' ? still() : flow());
} catch (error) {
  result.error = reason(error);
} finally {
  await writeFile(resultsPath, JSON.stringify(result));
}
