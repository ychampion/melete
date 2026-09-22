/**
 * Daytona, live. Skipped unless both `MELETE_SANDBOX_LIVE=daytona` and
 * `DAYTONA_API_KEY` are set; never part of an ordinary run.
 *
 * `MELETE_DAYTONA_SNAPSHOT` picks the snapshot the sandboxes start from; it
 * needs POSIX `sh`, GNU `find`, `curl` and `getent`. With
 * `MELETE_SANDBOX_RECORD=1` each conformance scenario re-records its fixture
 * from Daytona, marked `recorded`; run `bun run format` afterwards.
 *
 * The organisation must be allowed to set a sandbox's egress: Daytona documents
 * that Tier 1 and Tier 2 organisations cannot, and there the deny-all create is
 * expected to fail rather than run without its policy.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxConformance } from '../conformance.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import { type ExecutionRecord, runCommand } from '../marker.ts';
import type { EgressPolicy, SandboxProvider } from '../types.ts';
import { createDaytonaProvider, DAYTONA_API_URL } from './daytona.ts';
import {
  acknowledgementControl,
  DAYTONA_FIXTURE_API,
  fixturePath,
  RECORDED_NOTE,
} from './daytona-fixtures.ts';
import { RecordingFetch } from './fixtures.ts';

const apiKey = process.env.DAYTONA_API_KEY ?? '';
const live = process.env.MELETE_SANDBOX_LIVE === 'daytona' && apiKey.length > 0;

if (!live) {
  test.skip('Daytona live conformance needs MELETE_SANDBOX_LIVE=daytona and DAYTONA_API_KEY', () => {});
} else {
  const snapshot = process.env.MELETE_DAYTONA_SNAPSHOT ?? 'daytona-small';
  const record = process.env.MELETE_SANDBOX_RECORD === '1';
  const signal = () => AbortSignal.timeout(180_000);

  sandboxConformance(
    'daytona live',
    async (name) => {
      const recorder = record
        ? new RecordingFetch(fetch, {
            fixture: 'daytona',
            source: 'recorded',
            note: RECORDED_NOTE,
            api: DAYTONA_FIXTURE_API,
            secrets: [apiKey],
          })
        : null;
      const control = acknowledgementControl(recorder?.fetch ?? fetch);
      return {
        provider: createDaytonaProvider({ credential: (use) => use(apiKey), fetch: control.fetch }),
        image: snapshot,
        secrets: [apiKey],
        loseNextAcknowledgement: control.lose,
        close: async () => {
          if (recorder) await recorder.save(fixturePath(name));
        },
      };
    },
    { timeoutMs: 300_000 },
  );

  const provider: SandboxProvider = createDaytonaProvider({ credential: (use) => use(apiKey) });
  const open = (egress: EgressPolicy, session: string, persistence?: 'pause') =>
    openSandbox(
      provider,
      {
        image: snapshot,
        egress,
        region: null,
        lifetimeSeconds: 600,
        idleSeconds: null,
        workdir: '/work',
        labels: sandboxLabels({ project: 'live-probe', space: 'sp_LIVE', session }),
        env: {},
      },
      signal(),
      persistence,
    );

  test('deny-all egress holds from inside a Daytona sandbox: by name, by address, over IPv6, and as Daytona records it', async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-daytona-live-'));
    // Every check asks for an HTTP answer or a resolved name, never for a socket.
    const probe = [
      'sh',
      '-c',
      [
        'getent hosts example.com > /dev/null 2>&1',
        'printf \'dns=%s\\n\' "$?"',
        "curl -s -m 8 -o /dev/null -w 'v4_code=%{http_code}' http://1.1.1.1/ 2>/dev/null",
        'printf \' v4_exit=%s\\n\' "$?"',
        "curl -s -m 8 -o /dev/null -w 'name_code=%{http_code}' https://example.com/ 2>/dev/null",
        'printf \' name_exit=%s\\n\' "$?"',
        "curl -s -g -m 8 -o /dev/null -w 'v6_code=%{http_code}' 'http://[2606:4700:4700::1111]/' 2>/dev/null",
        'printf \' v6_exit=%s\\n\' "$?"',
        "curl -s -k -m 8 -o /dev/null -w 'google_dns_code=%{http_code}' https://8.8.8.8/ 2>/dev/null",
        'printf \' google_dns_exit=%s\\n\' "$?"',
      ].join('; '),
    ];
    const fields = (result: ExecutionRecord) =>
      Object.fromEntries(
        [...new TextDecoder().decode(result.preview).matchAll(/(\w+)=(\S+)/g)].map((match) => [
          match[1],
          match[2],
        ]),
      );
    const run = async (handle: Awaited<ReturnType<typeof open>>, marker: string) => {
      const result = await runCommand({
        provider,
        handle,
        request: { marker, argv: probe, timeoutMs: 90_000, dispatch: 'first' },
        workRoot,
        jobId: 'job_LIVEPROBE',
        signal: signal(),
      });
      if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
      return fields(result.record);
    };
    const denied = await open({ kind: 'deny_all' }, 'sbx_LIVEDENY');
    const control = await open({ kind: 'open' }, 'sbx_LIVEOPEN');
    try {
      const detail = (await (
        await fetch(`${DAYTONA_API_URL}/sandbox/${denied.providerSandboxId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
      ).json()) as { networkBlockAll?: boolean | null };
      expect(detail.networkBlockAll).toBe(true);
      const blocked = await run(denied, 'act_01J0LIVEPROBEDENY0000000');
      const reached = await run(control, 'act_01J0LIVEPROBEOPEN0000000');
      process.stdout.write(`daytona egress probe: denied ${JSON.stringify(blocked)}\n`);
      process.stdout.write(`daytona egress probe: open ${JSON.stringify(reached)}\n`);
      // The probe can see a network when one is there, so its failures mean something.
      expect(reached).toMatchObject({ dns: '0', v4_exit: '0', name_exit: '0' });
      expect(blocked.dns).not.toBe('0');
      expect(blocked.dns).not.toBe('127');
      for (const prefix of ['v4', 'name', 'v6', 'google_dns']) {
        expect(blocked[`${prefix}_code`]).toBe('000');
        expect(['6', '7', '28', '35', '52', '56']).toContain(blocked[`${prefix}_exit`] ?? '');
      }
    } finally {
      await provider.destroy(denied, signal()).catch(() => {});
      await provider.destroy(control, signal()).catch(() => {});
      await rm(workRoot, { recursive: true, force: true });
    }
  }, 600_000);

  test('a stopped Daytona workspace starts again with its files', async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-daytona-live-'));
    const handle = await open({ kind: 'deny_all' }, 'sbx_LIVEPAUSE', 'pause');
    try {
      const wrote = await runCommand({
        provider,
        handle,
        request: {
          marker: 'act_01J0LIVEPAUSE00000000000',
          argv: ['sh', '-c', 'printf kept > /work/kept.txt'],
          timeoutMs: 30_000,
          dispatch: 'first',
        },
        workRoot,
        jobId: 'job_LIVEPAUSE',
        signal: signal(),
      });
      expect(wrote.outcome).toBe('succeeded');
      const { resumeRef } = await (provider.pause as NonNullable<SandboxProvider['pause']>)(
        handle,
        signal(),
      );
      expect(await provider.inspect(handle, signal())).toBe('paused');
      const resumed = await (provider.resume as NonNullable<SandboxProvider['resume']>)(
        resumeRef,
        {
          image: snapshot,
          egress: { kind: 'deny_all' },
          region: null,
          lifetimeSeconds: 600,
          idleSeconds: null,
          workdir: '/work',
          labels: sandboxLabels({
            project: 'live-probe',
            space: 'sp_LIVE',
            session: 'sbx_LIVEPAUSE',
          }),
          env: {},
        },
        signal(),
      );
      expect(resumed.providerSandboxId).toBe(handle.providerSandboxId);
      const kept = await provider.getFile(resumed, '/work/kept.txt', 64, signal());
      expect(new TextDecoder().decode(kept)).toBe('kept');
    } finally {
      await provider.destroy(handle, signal()).catch(() => {});
      await rm(workRoot, { recursive: true, force: true });
    }
  }, 600_000);
}
