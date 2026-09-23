import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGN_IN, startSignInFixture } from '../../../test/helpers/browser-fixture.ts';
import { chromiumAvailable, chromiumMissingReason } from './available.ts';

const LIVE_SOURCES = ['live.ts', 'live-protocol.ts', 'live-routes.ts'];

/** Runs the scripted person in a Node child, where the worker and Chromium run. */
function scripted(mode: 'flow' | 'limits' | 'still') {
  const state = {
    fixture: undefined as unknown as ReturnType<typeof startSignInFixture>,
    run: { code: -1, stdout: '', stderr: '' },
    result: {} as Record<string, unknown>,
    directory: '',
  };
  beforeAll(async () => {
    state.fixture = startSignInFixture();
    state.directory = await mkdtemp(join(tmpdir(), 'melete-live-result-'));
    const file = join(state.directory, 'result.json');
    const child = Bun.spawn(
      [
        'node',
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(new URL('../../../test/helpers/browser-live-session.ts', import.meta.url)),
        file,
        mode,
        state.fixture.app,
        state.fixture.idp,
        state.fixture.other,
      ],
      { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
    );
    const timeout = setTimeout(() => child.kill(), 170_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      state.run = { code, stdout, stderr };
    } finally {
      clearTimeout(timeout);
    }
    state.result = JSON.parse(await readFile(file, 'utf8'));
  }, 180_000);
  afterAll(async () => {
    await state.fixture?.close();
    if (state.directory) await rm(state.directory, { recursive: true, force: true });
  });
  return state;
}

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
const suite = chromiumAvailable ? describe : describe.skip;

suite('a person in the live session against real Chromium', () => {
  const state = scripted('flow');
  const requests = (site: string, path?: string) =>
    state.fixture.requests.filter(
      (request) => request.site === site && (path === undefined || request.path === path),
    );

  test('a scripted person types into the fixture password field and the page receives it', () => {
    const { result } = state;
    expect(result.error).toBeUndefined();
    expect(result.agent_open).toBe('sensitive_input_require_takeover');
    expect(result.first_frame).toBe(true);
    expect(result.password_field).toBe(SIGN_IN.password);
    const signIn = requests('app', '/signin').filter((request) => request.method === 'POST');
    expect(signIn.map((request) => new URLSearchParams(request.body).get('password'))).toEqual([
      SIGN_IN.password,
    ]);
    expect(result.reached_otp).toBe(true);
    expect(result.reached_account).toBe(true);
    expect(requests('idp', '/idp')).toHaveLength(1);
  });

  test('input carrying the pre-takeover epoch is refused', () => {
    const { result } = state;
    expect(result.stale_dispatch).toBe('epoch_changed');
    expect(result.stale_dispatch_ran).toBeUndefined();
    expect(result.stale_open).toBe('epoch_changed');
    expect(result.second_open).toBe('live_taken');
    expect(result.stale_channel_input).toBe('live_closed');
    expect(result.stale_channel_pull).toEqual([{ type: 'ended', code: 'epoch_changed' }]);
    expect(result.stale_channel_after_end).toBe('live_closed');
    expect(result.note_field).toBe('');
    expect(JSON.stringify(state.fixture.requests)).not.toContain('must-not-arrive');
  });

  test('Chromium is not closed by the idle timer during an active takeover', () => {
    expect(state.result.alive_during_takeover).toBe(true);
    expect(state.result.closed_after_human_idle).toBe(true);
  });

  test('frames are JPEG, at most two are held, and a popup is followed then settled', () => {
    const { result } = state;
    expect(result.frame).toMatchObject({
      jpeg: 'ffd8ff',
      meta: { device_width: 1024, device_height: 768 },
    });
    expect(result.opened).toMatchObject({
      viewport: { width: 1024, height: 768 },
      site_scope: ['127.0.0.1'],
      live_id: 43,
    });
    expect((result.usage as { max_held_frames: number }).max_held_frames).toBeLessThanOrEqual(2);
    expect(result.popup_followed).toBe(true);
    expect(result.popup_closed_back).toBe(true);
    expect(result.pages_after_handback).toBe(1);
  });

  test('an animated page stays within ten frames a second and the takeover is not ended by frame volume', () => {
    const animated = state.result.animated as {
      frames: number;
      seconds: number;
      bytes_per_second: number;
      ended: string | null;
      still_accepts_input: string;
    };
    expect(animated.frames).toBeGreaterThan(10);
    expect(animated.frames).toBeLessThanOrEqual(Math.ceil(animated.seconds * 10) + 1);
    expect(animated.bytes_per_second).toBeLessThanOrEqual(500 * 1024);
    expect(animated.ended).toBeNull();
    expect(animated.still_accepts_input).toBe('accepted');
  });

  test('a sign-in page loads a script, an image and a frame from another public site', () => {
    expect(requests('other').map((request) => request.path)).toEqual(
      expect.arrayContaining(['/widget.js', '/pixel.gif', '/frame', '/beacon']),
    );
    expect(requests('app', '/widget-ran').length).toBeGreaterThan(0);
  });

  test('a cross-site request from a page carries no cookie for another signed-in site', () => {
    // The identity provider set a SameSite=None cookie while the person signed in; the account
    // page on another site requests an image from it, and that request carries no cookie.
    const avatar = requests('idp', '/avatar.png');
    expect(avatar.length).toBeGreaterThan(0);
    expect(avatar.map((request) => request.cookie)).toEqual(avatar.map(() => ''));
    // The first-party top-level return from the identity provider kept its own site's cookie.
    expect(requests('app', '/account')[0]?.cookie).toContain('step=code');
  });

  test('a redirect chain stops after twenty hops', () => {
    expect(state.result.loop_notice).toBe(true);
    expect(requests('app', '/loop').map((request) => request.search)).toEqual(
      Array.from({ length: 21 }, (_, n) => `?n=${n}`),
    );
  });

  test('a WebSocket from the page is refused in real Chromium', () => {
    expect(state.result.websocket_notice).toBe(true);
    expect(requests('app', '/socket')).toEqual([]);
    expect(requests('app', '/socket-closed').map((request) => request.search)).toEqual([
      '?code=1008',
    ]);
  });

  test('touch and wheel input reach the page', () => {
    expect(requests('app', '/event').map((request) => request.search)).toEqual(
      expect.arrayContaining(['?type=touchstart', '?type=wheel']),
    );
  });

  test('a person may open eight popups in a takeover, one at a time', () => {
    const { result } = state;
    expect(result.two_popups_first_followed).toBe(true);
    expect(result.two_popups_notice).toBe(true);
    expect(result.popups_before_limit).toBe(8);
    expect(result.ninth_popup).toMatchObject({ pages: 1, popups: 8 });
    expect((result.ninth_popup as { where: string }).where).toContain('/account');
  });

  test('the live module writes nothing to stdout or stderr', async () => {
    expect(state.run).toEqual({ code: 0, stdout: '', stderr: '' });
    for (const source of LIVE_SOURCES) {
      const text = await readFile(new URL(source, import.meta.url), 'utf8');
      expect(text).not.toMatch(
        /console\.|process\.(stdout|stderr)|node:fs|writeFile|appendFile|createWriteStream/,
      );
    }
  });
});

suite('a person in a live session with small injected limits', () => {
  const state = scripted('limits');

  test('the frame budget delays frames without ending the channel', () => {
    expect(state.result.error).toBeUndefined();
    const budget = state.result.frame_budget as {
      frames: number;
      bytes: number;
      largest: number;
      ended: string | null;
    };
    // Two kilobytes a second over ten seconds: an animated page gets a window of twenty.
    expect(budget.frames).toBeGreaterThan(0);
    expect(budget.bytes).toBeLessThanOrEqual(20_000 + budget.largest);
    expect(budget.ended).toBeNull();
  });

  test('the takeover cap closes the channel and leaves control with the person', () => {
    expect(state.result.cap).toMatchObject({
      ended: 'live_timeout',
      control: 'human',
      reopen: 'live_timeout',
    });
    expect((state.result.cap as { after_ms: number }).after_ms).toBeLessThan(6000);
  });

  test('the network budget ends the channel', () => {
    expect(state.result.network_budget).toMatchObject({ noticed: true, ended: 'live_budget' });
    expect(
      state.fixture.requests.filter((request) => request.path.startsWith('/tile')).length,
    ).toBeLessThan(6);
  });
});

suite('a person watching a page that repaints without changing', () => {
  const state = scripted('still');

  test('a frame identical to the last one delivered is skipped', () => {
    expect(state.result.error).toBeUndefined();
    const still = state.result.still as { received: number; delivered: number };
    expect(still.received).toBeGreaterThan(20);
    expect(still.delivered).toBeLessThanOrEqual(1);
  });
});
