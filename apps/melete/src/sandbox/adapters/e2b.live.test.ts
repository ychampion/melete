/**
 * E2B, live. Skipped unless both `MELETE_SANDBOX_LIVE=e2b` and `E2B_API_KEY`
 * are set; never part of an ordinary run.
 *
 * `MELETE_E2B_TEMPLATE` picks the template (default `base`) and
 * `MELETE_E2B_PLAN=pro` raises the lifetime the adapter declares. With
 * `MELETE_SANDBOX_RECORD=1` each conformance scenario re-records its fixture
 * from E2B, marked `recorded`; run `bun run format` afterwards.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxConformance } from '../conformance.ts';
import { openSandbox, sandboxLabels } from '../manifest.ts';
import { type ExecutionRecord, runCommand } from '../marker.ts';
import type { EgressPolicy, SandboxProvider } from '../types.ts';
import { createE2bProvider } from './e2b.ts';
import {
  acknowledgementControl,
  E2B_FIXTURE_API,
  fixturePath,
  RECORDED_NOTE,
} from './e2b-fixtures.ts';
import { RecordingFetch } from './fixtures.ts';

const apiKey = process.env.E2B_API_KEY ?? '';
const live = process.env.MELETE_SANDBOX_LIVE === 'e2b' && apiKey.length > 0;

if (!live) {
  test.skip('E2B live conformance needs MELETE_SANDBOX_LIVE=e2b and E2B_API_KEY', () => {});
} else {
  const template = process.env.MELETE_E2B_TEMPLATE ?? 'base';
  const plan = process.env.MELETE_E2B_PLAN === 'pro' ? 'pro' : 'hobby';
  const record = process.env.MELETE_SANDBOX_RECORD === '1';
  const signal = () => AbortSignal.timeout(180_000);

  sandboxConformance(
    'e2b live',
    async (name) => {
      const recorder = record
        ? new RecordingFetch(fetch, {
            fixture: 'e2b',
            source: 'recorded',
            note: RECORDED_NOTE,
            api: E2B_FIXTURE_API,
            secrets: [apiKey],
          })
        : null;
      const control = acknowledgementControl(recorder?.fetch ?? fetch);
      return {
        provider: createE2bProvider({
          credential: (use) => use(apiKey),
          fetch: control.fetch,
          plan,
        }),
        image: template,
        secrets: [apiKey],
        loseNextAcknowledgement: control.lose,
        close: async () => {
          if (recorder) await recorder.save(fixturePath(name));
        },
      };
    },
    { timeoutMs: 240_000 },
  );

  test('deny-all egress holds from inside an E2B sandbox: by name, by address, over IPv6, and as E2B records it', async () => {
    const provider: SandboxProvider = createE2bProvider({
      credential: (use) => use(apiKey),
      plan,
    });
    const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-e2b-live-'));
    // A blocked connection can look open at the TCP level on E2B, so every
    // check asks for an HTTP answer or a resolved name, never for a socket.
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
    const fields = (record: ExecutionRecord) =>
      Object.fromEntries(
        [...new TextDecoder().decode(record.preview).matchAll(/(\w+)=(\S+)/g)].map((match) => [
          match[1],
          match[2],
        ]),
      );
    const open = async (egress: EgressPolicy, session: string) =>
      openSandbox(
        provider,
        {
          image: template,
          egress,
          region: null,
          lifetimeSeconds: 600,
          idleSeconds: null,
          workdir: '/work',
          labels: sandboxLabels({ project: 'live-probe', space: 'sp_LIVE', session }),
          env: {},
        },
        signal(),
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
        await fetch(`https://api.e2b.app/sandboxes/${denied.providerSandboxId}`, {
          headers: { 'X-API-Key': apiKey },
        })
      ).json()) as { allowInternetAccess?: boolean | null };
      expect(detail.allowInternetAccess).toBe(false);
      const blocked = await run(denied, 'act_01J0LIVEPROBEDENY0000000');
      const reached = await run(control, 'act_01J0LIVEPROBEOPEN0000000');
      process.stdout.write(`e2b egress probe: denied ${JSON.stringify(blocked)}\n`);
      process.stdout.write(`e2b egress probe: open ${JSON.stringify(reached)}\n`);
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
  }, 300_000);
}
