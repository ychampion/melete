import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { BrowserWorkerClient, browserWorkerEnvironment } from '../../src/workers/browser/client.ts';
import type { BrowserCommandResult } from '../../src/workers/browser/controller.ts';
import type { LiveDown, LiveInput, LiveOpen } from '../../src/workers/browser/live-protocol.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';
import { SIGN_IN, SIGN_IN_POINTS, startSignInFixture } from '../helpers/browser-fixture.ts';

const JOB = 'job_live_worker';

/** Every file under the space except Chromium's own profile storage, with a content digest. */
async function spaceFiles(root: string, directory = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relative = path.slice(root.length + 1).replaceAll('\\', '/');
    if (relative === 'browser/chromium') continue;
    if (entry.isDirectory()) Object.assign(files, await spaceFiles(root, path));
    else
      files[relative] = new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex');
  }
  return files;
}

const reason = async (operation: Promise<unknown>) => {
  try {
    await operation;
    return 'accepted';
  } catch (error) {
    return error instanceof Error
      ? ((error as Error & { reason?: string }).reason ?? error.message)
      : 'error';
  }
};

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? describe : describe.skip)(
  'the live channel through the worker listener',
  () => {
    let fixture: ReturnType<typeof startSignInFixture>;
    let spaceRoot = '';
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let worker: BrowserWorkerClient;
    let session: BrowserSession;
    let open: LiveOpen;
    let seq = 0;
    let where = '';
    const notices: LiveDown[] = [];
    const output = { stdout: '', stderr: '' };
    let beforeHuman: Record<string, string> = {};

    const command = (operation: unknown) =>
      worker.request<BrowserCommandResult>('/command', {
        session_id: session.id,
        job_id: JOB,
        control_epoch: session.control_epoch,
        operation,
      });
    const pull = async (timeout = 500) => {
      const { events } = await worker.livePull(open.live_id, seq, timeout);
      for (const event of events) {
        if (event.type === 'frame') seq = event.seq;
        if (event.type === 'where') where = event.url;
        if (event.type === 'notice' || event.type === 'ended') notices.push(event);
      }
      return events;
    };
    const until = async (predicate: () => boolean, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !predicate()) await pull();
      return predicate();
    };
    const send = (events: LiveInput[]) => worker.liveInput(open.live_id, seq, events);
    const click = (point: { x: number; y: number }) =>
      send([
        { k: 'down', ...point, button: 0, mods: 0, clicks: 1 },
        { k: 'up', ...point, button: 0, mods: 0, clicks: 1 },
      ]);
    const enter = () =>
      send([
        { k: 'key', down: true, key: 'Enter', code: 'Enter', vk: 13, mods: 0, text: '\r' },
        { k: 'key', down: false, key: 'Enter', code: 'Enter', vk: 13, mods: 0 },
      ]);

    beforeAll(async () => {
      fixture = startSignInFixture();
      spaceRoot = await mkdtemp(join(tmpdir(), 'melete-live-worker-'));
      const token = randomBytes(32).toString('base64url');
      const spawned = Bun.spawn(
        [
          'node',
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          fileURLToPath(new URL('../helpers/browser-child.ts', import.meta.url)),
          fixture.app,
          fixture.idp,
          fixture.other,
        ],
        {
          cwd: spaceRoot,
          env: {
            ...browserWorkerEnvironment(process.env),
            MELETE_BROWSER_SPACE: 'sp_live_worker',
            MELETE_BROWSER_ROOT: spaceRoot,
            MELETE_BROWSER_TOKEN: token,
          },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          windowsHide: true,
        },
      );
      child = spawned;
      const decoder = new TextDecoder();
      void (async () => {
        for await (const chunk of spawned.stderr as ReadableStream<Uint8Array>)
          output.stderr += decoder.decode(chunk);
      })();
      const ready = new Promise<number>((resolve, reject) => {
        void (async () => {
          let line = '';
          for await (const chunk of spawned.stdout as ReadableStream<Uint8Array>) {
            const text = decoder.decode(chunk);
            if (line.includes('\n')) output.stdout += text;
            else {
              line += text;
              const newline = line.indexOf('\n');
              if (newline >= 0) {
                output.stdout += line.slice(newline + 1);
                resolve(JSON.parse(line.slice(0, newline)).port);
              }
            }
          }
          reject(new Error('worker exited before it was ready'));
        })();
      });
      worker = new BrowserWorkerClient(`http://127.0.0.1:${await ready}`, token);
      session = await worker.lease(JOB, {
        public_compartment: false,
        allowed_domains: ['127.0.0.1'],
      });
      await command({ kind: 'observe' });
      expect(await reason(command({ kind: 'open', url: `${fixture.app}/signin` }))).toBe(
        'sensitive_input_require_takeover',
      );
    }, 30_000);

    afterAll(async () => {
      await worker?.request('/release', {}).catch(() => {});
      child?.kill();
      await child?.exited;
      await fixture?.close();
      if (spaceRoot) await rm(spaceRoot, { recursive: true, force: true }).catch(() => {});
    }, 30_000);

    test('live pull returns frames and refuses a stale epoch', async () => {
      const beforeTakeover = session.control_epoch;
      expect(await reason(worker.liveOpen(session.id, beforeTakeover))).toBe('not_human_control');
      session = await worker.takeover(session.id);
      beforeHuman = await spaceFiles(spaceRoot);
      expect(await reason(worker.liveOpen(session.id, beforeTakeover))).toBe('epoch_changed');
      open = await worker.liveOpen(session.id, session.control_epoch);
      expect(open).toMatchObject({
        control_epoch: session.control_epoch,
        viewport: { width: 1024, height: 768 },
        site_scope: ['127.0.0.1'],
      });
      expect(await reason(worker.liveOpen(session.id, session.control_epoch))).toBe('live_taken');
      let frame: Extract<LiveDown, { type: 'frame' }> | undefined;
      const deadline = Date.now() + 10_000;
      while (!frame && Date.now() < deadline)
        frame = (await pull(2000)).find((event) => event.type === 'frame');
      expect(
        Buffer.from(frame?.data ?? '', 'base64')
          .subarray(0, 3)
          .toString('hex'),
      ).toBe('ffd8ff');
      expect(frame?.meta).toMatchObject({ device_width: 1024, device_height: 768, page_scale: 1 });
      expect(await until(() => where === `${fixture.app}/signin`)).toBe(true);
      expect(await reason(worker.livePull('A'.repeat(43), 0, 0))).toBe('live_closed');
      for (const invalid of [
        { live_id: open.live_id, ack_through: 0, timeout_ms: 60_000 },
        { live_id: open.live_id, ack_through: -1, timeout_ms: 0 },
        { live_id: 'short', ack_through: 0, timeout_ms: 0 },
      ])
        expect(await reason(worker.request('/live/pull', invalid))).toBe('invalid_request');
      expect(
        await reason(
          worker.request('/live/input', {
            live_id: open.live_id,
            ack_through: 0,
            events: [
              { k: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.cookie' } },
            ],
          }),
        ),
      ).toBe('invalid_request');
      const response = await fetch(new URL('/live/pull', worker.url), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'x'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ live_id: open.live_id, ack_through: 0, timeout_ms: 0 }),
      });
      expect(response.status).toBe(401);
    }, 30_000);

    test('human mode allows the identity-provider redirect and refuses an off-scope host', async () => {
      await click(SIGN_IN_POINTS.first_field);
      await send([
        { k: 'key', down: true, key: 'c', code: 'KeyC', vk: 67, mods: 0, text: 'c' },
        { k: 'key', down: false, key: 'c', code: 'KeyC', vk: 67, mods: 0 },
        { k: 'text', text: SIGN_IN.password.slice(1) },
      ]);
      await enter();
      expect(await until(() => where === `${fixture.app}/otp`)).toBe(true);
      await click(SIGN_IN_POINTS.first_field);
      await send([{ k: 'text', text: SIGN_IN.code }]);
      await enter();
      expect(await until(() => where.startsWith(`${fixture.app}/account`))).toBe(true);
      expect(
        await until(() =>
          notices.some((notice) => notice.type === 'notice' && notice.code === 'off_scope'),
        ),
      ).toBe(true);
      await pull(1000);

      const app = fixture.requests.filter((request) => request.site === 'app');
      expect(
        app
          .filter((request) => request.method === 'POST')
          .map((request) => [request.path, request.body]),
      ).toEqual([
        ['/signin', `password=${encodeURIComponent(SIGN_IN.password).replaceAll('%20', '+')}`],
        ['/otp', `code=${SIGN_IN.code}`],
      ]);
      expect(
        fixture.requests.filter((request) => request.site === 'idp').map((r) => r.path),
      ).toEqual(['/idp']);
      const account = app.find((request) => request.path === '/account');
      expect(account?.search).toStartWith('?ticket=');
      expect(account?.cookie).toContain('step=code');
      // The account page asked for an image and a beacon on a third address: neither left Chromium.
      expect(fixture.requests.filter((request) => request.site === 'other')).toEqual([]);
      expect(
        notices.filter((notice) => notice.type === 'notice' && notice.code === 'off_scope'),
      ).toEqual([{ type: 'notice', code: 'off_scope', host: '127.0.0.3' }]);
      expect(await worker.liveScope(open.live_id, '127.0.0.3')).toEqual({
        site_scope: ['127.0.0.1', '127.0.0.2', '127.0.0.3'],
      });
      expect(await reason(worker.liveScope(open.live_id, '127.0.0.4:8080'))).toBe('invalid_host');
    }, 45_000);

    test('a file chooser during takeover is cancelled', async () => {
      await click(SIGN_IN_POINTS.upload);
      expect(
        await until(() =>
          notices.some((notice) => notice.type === 'notice' && notice.code === 'upload_refused'),
        ),
      ).toBe(true);
      expect(
        await until(() => fixture.requests.some((request) => request.path === '/chooser')),
      ).toBe(true);
      expect(
        fixture.requests.filter((request) => request.path === '/chooser').map((r) => r.search),
      ).toEqual(['?event=cancel']);
    }, 30_000);

    test('input above the rate cap is refused and the channel closes', async () => {
      await click(SIGN_IN_POINTS.first_field);
      const typed = (text: string): LiveInput => ({ k: 'text', text });
      expect(
        await reason(
          send([typed('over'), typed('-the'), typed('-cap'), typed('-by'), typed('-one')]),
        ),
      ).toBe('slow_down');
      expect(notices.filter((notice) => notice.type === 'ended')).toEqual([]);
      expect(await pull(0)).toContainEqual({ type: 'ended', code: 'slow_down' });
      expect(await reason(send([typed('after the close')]))).toBe('live_closed');
      expect(await reason(pull(0))).toBe('live_closed');
      // The channel ended; the person still holds control and can open another one.
      open = await worker.liveOpen(session.id, session.control_epoch);
      seq = 0;
      const moves = (length: number) =>
        Array.from(
          { length },
          (): LiveInput => ({ k: 'move', x: 500, y: 700, button: 0, mods: 0, clicks: 1 }),
        );
      expect(await send(moves(20))).toEqual({ accepted: 20 });
      // Two hundred events arrive together with twenty more: the second batch exceeds the rate.
      const outcomes = await Promise.all([reason(send(moves(200))), reason(send(moves(20)))]);
      expect(outcomes).toContain('slow_down');
      expect(await pull(0)).toContainEqual({ type: 'ended', code: 'slow_down' });
    }, 30_000);

    test('takeover writes no artifact row and no artifact file', async () => {
      const files = await spaceFiles(spaceRoot);
      expect(Object.keys(files).some((path) => path.includes('artifact'))).toBe(false);
      for (const source of ['live.ts', 'live-protocol.ts', 'live-routes.ts']) {
        const text = await readFile(
          new URL(`../../src/workers/browser/${source}`, import.meta.url),
          'utf8',
        );
        expect(text).not.toMatch(/artifacts\.ts|BrowserArtifactSink|insert into|node:fs/);
      }
    });

    test("no file under the profile changes during a takeover except Chromium's own storage", async () => {
      expect(Object.keys(beforeHuman)).toEqual(['browser/session.json']);
      expect(await spaceFiles(spaceRoot)).toEqual(beforeHuman);
      const record = await readFile(join(spaceRoot, 'browser', 'session.json'), 'utf8');
      for (const secret of [SIGN_IN.password, SIGN_IN.code, fixture.idp, 'over-the-cap'])
        expect(record).not.toContain(secret);
    });

    test('the first observation after handback carries no screenshot and a redacted tree', async () => {
      session = await worker.handback(session.id);
      const first = await command({ kind: 'observe' });
      expect(first.observation?.url).toStartWith(`${fixture.app}/account`);
      expect(first.observation?.screenshot).toBe('');
      const redacted = first.observation?.tree ?? '';
      expect(redacted).toContain('Your account');
      expect(redacted).toContain('[redacted]');
      for (const secret of [SIGN_IN.backup_code, SIGN_IN.reference, 'over-the-cap'])
        expect(redacted).not.toContain(secret);
      const second = await command({ kind: 'observe' });
      expect(second.observation?.screenshot.length).toBeGreaterThan(1000);
      expect(second.observation?.tree).toContain(SIGN_IN.backup_code);
      expect(second.observation?.tree).toContain(SIGN_IN.reference);

      // Handed back with a password field showing, the observation still refuses, and the next
      // one that completes is still the one without a picture.
      expect(await reason(command({ kind: 'open', url: `${fixture.app}/signin` }))).toBe(
        'sensitive_input_require_takeover',
      );
      session = await worker.takeover(session.id);
      session = await worker.handback(session.id);
      expect(await reason(command({ kind: 'observe' }))).toBe('sensitive_input_require_takeover');
      session = await worker.takeover(session.id);
      open = await worker.liveOpen(session.id, session.control_epoch);
      seq = 0;
      where = '';
      expect(await until(() => where === `${fixture.app}/signin`)).toBe(true);
      await click(SIGN_IN_POINTS.back_to_account);
      expect(await until(() => where === `${fixture.app}/account`)).toBe(true);
      session = await worker.handback(session.id);
      expect(await pull(0)).toContainEqual({ type: 'ended', code: 'epoch_changed' });
      expect(await reason(pull(0))).toBe('live_closed');
      const afterRefusal = await command({ kind: 'observe' });
      expect(afterRefusal.observation?.screenshot).toBe('');
      expect(afterRefusal.observation?.tree).not.toContain(SIGN_IN.backup_code);
      expect((await command({ kind: 'observe' })).observation?.screenshot).not.toBe('');
    }, 45_000);

    test('the live module writes nothing to stdout or stderr', () => {
      expect(output).toEqual({ stdout: '', stderr: '' });
    });
  },
);
