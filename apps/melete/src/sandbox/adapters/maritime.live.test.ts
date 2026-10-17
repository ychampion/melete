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
import { sandboxConformance } from '../conformance.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
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
}
