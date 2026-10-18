/**
 * Maritime, live. Skipped unless `MELETE_MARITIME_API_KEY` is set; never part
 * of an ordinary run. Use a key whose only scope is `computers`.
 *
 * By default it makes one computer, answers the questions Maritime's
 * documentation leaves open, and deletes it: whether a computer reaches the
 * internet, whether a command started in the background outlives the
 * thirty-second `exec` and a sleep, what the files API does at its 8 MiB cap,
 * and whether `/work` can be made. Each finding is printed as one
 * `maritime probe:` line.
 *
 * With `MELETE_SANDBOX_LIVE=maritime` as well, the whole conformance suite
 * runs, one computer per scenario; with `MELETE_SANDBOX_RECORD=1` each scenario
 * re-records its fixture, marked `recorded`. Run `bun run format` afterwards.
 *
 * Every computer it makes is deleted, pass or fail.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Action } from '@melete/contracts';
import { runComputerAction } from '../../connectors/sandbox-computer.ts';
import { desktopOf } from '../../connectors/sandbox-desktop.ts';
import { MemoryComputerControls } from '../computer-control.ts';
import { sandboxConformance } from '../conformance.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
import type { SessionRow } from '../sessions.ts';
import type { SandboxHandle, SandboxSpec } from '../types.ts';
import { RecordingFetch } from './fixtures.ts';
import { createMaritimeProvider, MARITIME_FILE_LIMIT } from './maritime.ts';
import {
  acknowledgementControl,
  fixturePath,
  MARITIME_FIXTURE_API,
  RECORDED_NOTE,
} from './maritime-fixtures.ts';

const apiKey = process.env.MELETE_MARITIME_API_KEY ?? '';

if (!apiKey) {
  test.skip('Maritime live checks need MELETE_MARITIME_API_KEY', () => {});
} else {
  const signal = () => AbortSignal.timeout(240_000);
  const say = (line: string) => process.stdout.write(`maritime probe: ${line}\n`);

  if (process.env.MELETE_SANDBOX_LIVE === 'maritime') {
    const record = process.env.MELETE_SANDBOX_RECORD === '1';
    sandboxConformance(
      'maritime live',
      async (name) => {
        const recorder = record
          ? new RecordingFetch(fetch, {
              fixture: 'maritime',
              source: 'recorded',
              note: RECORDED_NOTE,
              api: MARITIME_FIXTURE_API,
              secrets: [apiKey],
            })
          : null;
        const control = acknowledgementControl(recorder?.fetch ?? fetch);
        return {
          provider: createMaritimeProvider({
            credential: (use) => use(apiKey),
            fetch: control.fetch,
          }),
          image: 'linux',
          secrets: [apiKey],
          loseNextAcknowledgement: control.lose,
          close: async () => {
            if (recorder) await recorder.save(fixturePath(name));
          },
        };
      },
      { timeoutMs: 300_000 },
    );
  }

  test('what Maritime does not document, asked of one computer', async () => {
    const provider = createMaritimeProvider({ credential: (use) => use(apiKey) });
    const spec: SandboxSpec = {
      image: 'linux',
      egress: { kind: 'open' },
      region: null,
      lifetimeSeconds: 3600,
      idleSeconds: null,
      workdir: '/work',
      labels: sandboxLabels({ project: 'live-probe', space: 'sp_LIVE', session: 'sbx_LIVEPROBE' }),
      env: {},
    };
    const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-maritime-live-'));
    let handle: SandboxHandle | null = null;
    let created = 0;
    let deleted = 0;
    let markers = 0;
    const run = async (script: string, timeoutMs = 120_000) => {
      markers += 1;
      const result = await runCommand({
        provider,
        handle: handle as SandboxHandle,
        request: {
          marker: `act_01J0MARITIMELIVE${String(markers).padStart(6, '0')}`,
          argv: ['sh', '-c', script],
          timeoutMs,
          dispatch: 'first',
        },
        workRoot,
        jobId: 'job_MARITIMELIVE',
        signal: signal(),
      });
      if (result.outcome !== 'succeeded')
        throw new Error(`the probe did not run: ${result.outcome}`);
      return {
        exitCode: result.record.exitCode,
        text: new TextDecoder().decode(result.record.preview),
        durationMs: result.record.durationMs,
      };
    };
    try {
      handle = await openSandbox(provider, spec, signal());
      created += 1;
      say(`computer made and prepared; /work is ready`);
      const who = await run(
        'id; uname -m; ls -ld /work /data; sudo -n true 2>&1 && echo sudo=yes || echo sudo=no',
      );
      say(`identity: ${JSON.stringify(who.text)}`);

      // Egress, by name and by address, over both families.
      const egress = await run(
        [
          'getent hosts example.com > /dev/null 2>&1; printf "dns=%s " "$?"',
          "curl -s -m 8 -o /dev/null -w 'v4=%{http_code} ' http://1.1.1.1/",
          "curl -s -m 8 -o /dev/null -w 'name=%{http_code} ' https://example.com/",
          "curl -s -g -m 8 -o /dev/null -w 'v6=%{http_code}' 'http://[2606:4700:4700::1111]/'",
        ].join('; '),
      );
      say(`egress: ${egress.text}`);

      // A command longer than one exec: it must finish once, through the marker.
      const long = await run('sleep 45; printf long-done', 120_000);
      say(`45 s command: exit ${long.exitCode} after ${long.durationMs} ms, said ${long.text}`);
      expect(long.text).toBe('long-done');

      // A process left in the background, across a sleep and a wake.
      await run(
        'nohup sh -c "while :; do date +%s > /data/heartbeat; sleep 5; done" > /dev/null 2>&1 & echo started',
      );
      const pause = provider.pause as NonNullable<typeof provider.pause>;
      const resume = provider.resume as NonNullable<typeof provider.resume>;
      const { resumeRef } = await pause(handle, signal());
      say(`asleep: ${await provider.inspect(handle, signal())}`);
      handle = await resume(resumeRef, spec, signal());
      const beat = await run(
        'a=$(cat /data/heartbeat); sleep 7; b=$(cat /data/heartbeat); echo "$a $b"',
      );
      say(`background loop across sleep (two heartbeats 7 s apart): ${beat.text.trim()}`);

      // The files API at its cap: one byte above it is refused by the adapter;
      // exactly the cap goes through.
      await provider.putFiles(
        handle,
        (async function* () {
          yield { path: '/work/cap.bin', bytes: new Uint8Array(MARITIME_FILE_LIMIT), mode: 0o644 };
        })(),
        signal(),
      );
      const back = await provider.getFile(handle, '/work/cap.bin', MARITIME_FILE_LIMIT, signal());
      say(`8 MiB file written and read back: ${back.byteLength} bytes`);
      expect(back.byteLength).toBe(MARITIME_FILE_LIMIT);

      const shot = await provider.screenshot(handle, signal());
      say(`screenshot: ${shot.type} ${shot.width}x${shot.height}, ${shot.bytes.byteLength} bytes`);
      const watch = await provider.viewerLink(handle, { mode: 'watch', ttlSeconds: 60 }, signal());
      // The link is a credential for this computer: only that one was made is printed.
      say(`watch link made, expires ${watch.expiresAt}`);
    } finally {
      if (handle) {
        await provider.destroy(handle, signal()).then(
          () => {
            deleted += 1;
          },
          () => {},
        );
        say(
          `computers made ${created}, deleted ${deleted}; now ${await provider.inspect(handle, signal()).catch(() => 'unknown')}`,
        );
      }
      await rm(workRoot, { recursive: true, force: true });
    }
    expect(deleted).toBe(created);
  }, 900_000);

  test('the desktop round trip: look, click and type into a window, look again, take the wheel', async () => {
    const provider = createMaritimeProvider({ credential: (use) => use(apiKey) });
    const spec: SandboxSpec = {
      image: 'linux',
      egress: { kind: 'open' },
      region: null,
      lifetimeSeconds: 3600,
      idleSeconds: null,
      workdir: '/work',
      labels: sandboxLabels({ project: 'live-probe', space: 'sp_LIVE', session: 'sbx_LIVEDESK' }),
      env: {},
    };
    const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-maritime-desk-'));
    const controls = new MemoryComputerControls();
    let handle: SandboxHandle | null = null;
    let created = 0;
    let deleted = 0;
    let steps = 0;
    const run = async (script: string, timeoutMs = 60_000) => {
      steps += 1;
      const result = await runCommand({
        provider,
        handle: handle as SandboxHandle,
        request: {
          marker: `act_01J0MARITIMEDESK${String(steps).padStart(6, '0')}`,
          argv: ['sh', '-c', script],
          timeoutMs,
          dispatch: 'first',
        },
        workRoot,
        jobId: 'job_MARITIMEDESK',
        signal: signal(),
      });
      if (result.outcome !== 'succeeded')
        throw new Error(`the step did not run: ${result.outcome}`);
      return new TextDecoder().decode(result.record.preview).trim();
    };
    const listed = async () => {
      const response = await fetch('https://api.maritime.sh/api/v1/computers', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: signal(),
      });
      const body = (await response.json()) as { computers?: unknown[] };
      return Array.isArray(body.computers) ? body.computers.length : -1;
    };
    try {
      say(`computers on the account before: ${await listed()}`);
      handle = await openSandbox(provider, spec, signal());
      created += 1;
      const desktop = desktopOf(provider);
      if (!desktop) throw new Error('a Maritime computer has a desktop');
      const session = {
        id: 'sbx_LIVEDESK',
        providerSandboxId: handle.providerSandboxId,
        imageDigest: null,
        region: null,
      } as unknown as SessionRow;
      let acted = 0;
      const tool = (kind: string, payload: Record<string, unknown>) =>
        runComputerAction({
          action: {
            id: `act_LIVEDESK${String(++acted).padStart(4, '0')}`,
            kind,
            canonical_payload: { step: acted, ...payload },
          } as unknown as Action,
          jobId: 'job_MARITIMEDESK',
          workRoot,
          session,
          provider: desktop,
          controls,
          signal: signal(),
          challengeWaitMs: 0,
        });

      const apps = await run(
        'for a in xterm xfce4-terminal lxterminal mousepad gedit leafpad firefox chromium; do command -v $a > /dev/null && printf "%s " $a; done; printf "| DISPLAY=%s | " "$DISPLAY"; ls /tmp/.X11-unix 2>&1 | tr "\\n" " "',
      );
      say(`desktop: ${apps}`);
      const before = await tool('computer.screenshot', {});
      say(`first screenshot: ${before.width}x${before.height}, ${before.bytes} bytes`);
      expect([before.width, before.height]).toEqual([1200, 750]);

      // A terminal in a known place, so a click lands in it and what is typed can be read back.
      const word = `melete-${Date.now().toString(36)}`;
      const terminal = apps
        .split(' ')
        .find((each) => each === 'xterm' || each === 'xfce4-terminal');
      if (terminal === 'xterm')
        await run(
          `DISPLAY="\${DISPLAY:-:0}" setsid xterm -geometry 80x20+80+80 > /dev/null 2>&1 & sleep 3; echo up`,
        );
      else if (terminal)
        await run(
          `DISPLAY="\${DISPLAY:-:0}" setsid ${terminal} --geometry=80x20+80+80 > /dev/null 2>&1 & sleep 4; echo up`,
        );
      say(`window opened: ${terminal ?? 'none found; typing into whatever has focus'}`);
      await tool('computer.screenshot', {});
      const clicked = await tool('computer.click', { x: 300, y: 220 });
      say(`click: ${clicked.screenshot ?? `screenshot ${clicked.width}x${clicked.height}`}`);
      const typed = await tool('computer.type', {
        text: `echo ${word} > /data/work/typed.txt`,
      });
      await tool('computer.key', { keys: ['Return'] });
      const after = await tool('computer.screenshot', {});
      say(
        `typed; screenshot ${after.width}x${after.height}, changed from the first: ${after.sha256 !== before.sha256}`,
      );
      expect(typed.computer).toBe('type');
      if (terminal) {
        const read = await run('sleep 1; cat /data/work/typed.txt 2>&1 || true');
        say(`what the window wrote: ${read === word ? 'the typed word' : JSON.stringify(read)}`);
        expect(read).toBe(word);
      }

      // Take the wheel: a control link, and who Maritime says holds the desktop at each turn.
      const agentTries = async () =>
        tool('computer.key', { keys: ['shift'] }).then(
          () => 'the agent acts',
          (error: Error) => `the agent is refused (${error.message.slice(0, 40)}...)`,
        );
      const holding = async () => provider.holder(handle as SandboxHandle, signal());
      say(`before any link: holder ${await holding()}`);
      const minted = Date.now();
      const control = await provider.viewerLink(
        handle,
        { mode: 'control', ttlSeconds: 30 },
        signal(),
      );
      expect(control.mode).toBe('control');
      say(
        `control link made, lasting ${Math.round((Date.parse(control.expiresAt) - minted) / 1000)} s; holder ${await holding()}; ${await agentTries()}`,
      );
      const page = await fetch(control.url, { redirect: 'manual', signal: signal() }).catch(
        () => null,
      );
      await page?.body?.cancel().catch(() => {});
      say(
        `control link opened: ${page?.status ?? 'no answer'}; x-frame-options ${page?.headers.get('x-frame-options') ?? '-'}; frame-ancestors ${/frame-ancestors[^;]*/.exec(page?.headers.get('content-security-policy') ?? '')?.[0] ?? '-'}; holder ${await holding()}; ${await agentTries()}`,
      );
      await provider.endViewers(handle, signal());
      say(`after the session was closed: holder ${await holding()}; ${await agentTries()}`);
      // The link has run out: does the desktop come back by itself?
      await Bun.sleep(Math.max(0, minted + 45_000 - Date.now()));
      say(`45 s after the link was made: holder ${await holding()}; ${await agentTries()}`);
      await Bun.sleep(Math.max(0, minted + 100_000 - Date.now()));
      say(`100 s after: holder ${await holding()}; ${await agentTries()}`);
      const watch = await provider.viewerLink(handle, { mode: 'watch', ttlSeconds: 60 }, signal());
      say(`watch link made; holder ${await holding()}; ${await agentTries()}`);
      expect(watch.mode).toBe('watch');
    } finally {
      if (handle) {
        await provider.destroy(handle, signal()).then(
          () => {
            deleted += 1;
          },
          (error: unknown) => say(`delete failed: ${String(error)}`),
        );
        say(
          `computers made ${created}, deleted ${deleted}; ours now ${await provider.inspect(handle, signal()).catch(() => 'unknown')}; on the account: ${await listed().catch(() => -1)}`,
        );
      }
      await rm(workRoot, { recursive: true, force: true });
    }
    expect(deleted).toBe(created);
  }, 900_000);
}
