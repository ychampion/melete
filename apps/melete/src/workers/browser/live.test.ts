import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGN_IN, startSignInFixture } from '../../../test/helpers/browser-fixture.ts';
import { chromiumAvailable, chromiumMissingReason } from './available.ts';

const LIVE_SOURCES = ['live.ts', 'live-protocol.ts'];

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? describe : describe.skip)(
  'a person in the live session against real Chromium',
  () => {
    let fixture: ReturnType<typeof startSignInFixture>;
    let run: { code: number; stdout: string; stderr: string };
    let result: Record<string, unknown>;
    let directory = '';
    beforeAll(async () => {
      fixture = startSignInFixture();
      directory = await mkdtemp(join(tmpdir(), 'melete-live-result-'));
      const file = join(directory, 'result.json');
      const child = Bun.spawn(
        [
          'node',
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          fileURLToPath(new URL('../../../test/helpers/browser-live-session.ts', import.meta.url)),
          file,
          fixture.app,
          fixture.idp,
          fixture.other,
        ],
        { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
      );
      const timeout = setTimeout(() => child.kill(), 110_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        run = { code, stdout, stderr };
      } finally {
        clearTimeout(timeout);
      }
      result = JSON.parse(await readFile(file, 'utf8'));
    }, 120_000);
    afterAll(async () => {
      await fixture?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    test('a scripted person types into the fixture password field and the page receives it', () => {
      expect(result.error).toBeUndefined();
      expect(result.agent_open).toBe('sensitive_input_require_takeover');
      expect(result.first_frame).toBe(true);
      expect(result.password_field).toBe(SIGN_IN.password);
      const signIn = fixture.requests.filter(
        (request) => request.path === '/signin' && request.method === 'POST',
      );
      expect(signIn.map((request) => new URLSearchParams(request.body).get('password'))).toEqual([
        SIGN_IN.password,
      ]);
      expect(result.reached_otp).toBe(true);
      expect(result.reached_account).toBe(true);
      expect(fixture.requests.some((request) => request.site === 'idp')).toBe(true);
    });

    test('input carrying the pre-takeover epoch is refused', () => {
      expect(result.stale_dispatch).toBe('epoch_changed');
      expect(result.stale_dispatch_ran).toBeUndefined();
      expect(result.stale_open).toBe('epoch_changed');
      expect(result.second_open).toBe('live_taken');
      expect(result.stale_channel_input).toBe('live_closed');
      expect(result.stale_channel_pull).toEqual([{ type: 'ended', code: 'epoch_changed' }]);
      expect(result.stale_channel_after_end).toBe('live_closed');
      expect(result.note_field).toBe('');
      expect(JSON.stringify(fixture.requests)).not.toContain('must-not-arrive');
    });

    test('Chromium is not closed by the idle timer during an active takeover', () => {
      expect(result.alive_during_takeover).toBe(true);
      expect(result.closed_after_human_idle).toBe(true);
    });

    test('frames are JPEG, at most two are held, and a popup is followed then settled', () => {
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
      expect((result.animated as { frames: number }).frames).toBeGreaterThan(2);
      expect(result.popup_followed).toBe(true);
      expect(result.popup_closed_back).toBe(true);
      expect(result.pages_after_handback).toBe(1);
    });

    test('the live module writes nothing to stdout or stderr', async () => {
      expect(run).toEqual({ code: 0, stdout: '', stderr: '' });
      for (const source of LIVE_SOURCES) {
        const text = await readFile(new URL(source, import.meta.url), 'utf8');
        expect(text).not.toMatch(
          /console\.|process\.(stdout|stderr)|node:fs|writeFile|appendFile|createWriteStream/,
        );
      }
    });
  },
);
