/**
 * Modal, live. Skipped unless `MELETE_SANDBOX_LIVE=modal`; never part of an
 * ordinary run.
 *
 * The token is read here, and only here, from the active profile in
 * `~/.modal.toml`, and reaches the adapter through its credential callback. It
 * is never printed, logged or written. Every sandbox is created in the app
 * `melete-sandbox-conformance` with 0.125 CPU, 128 MiB and a five-minute
 * lifetime: two for the conformance suite (one deny-all, one open for the
 * egress probe's positive control) and one by a separate process that has no
 * Modal environment variables and no config file. Every sandbox is terminated
 * when its test ends, whatever happened, and the run ends by listing the app
 * and failing if anything is still running.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxConformance } from '../conformance.ts';
import { createModalProvider } from './modal.ts';
import { createModalSdkTransport, openModalClient } from './modal-sdk.ts';
import {
  type ModalToken,
  type ModalTransport,
  ModalUnavailable,
  modalAcknowledgementControl,
} from './modal-transport.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'modal';
const APP = 'melete-sandbox-conformance';
const IMAGE = 'buildpack-deps:bookworm-curl';
const LIFETIME_SECONDS = 300;
const signal = () => AbortSignal.timeout(120_000);
const log = (line: string) => process.stdout.write(`modal live: ${line}\n`);
/** Blocked connections can look open at the TCP level, so each check asks for an answer or a name. */
const PROBE = [
  'getent hosts example.com > /dev/null 2>&1',
  'printf \'dns=%s\\n\' "$?"',
  "curl -s -m 5 -o /dev/null -w 'v4_code=%{http_code}' http://1.1.1.1/ 2>/dev/null",
  'printf \' v4_exit=%s\\n\' "$?"',
  "curl -s -m 5 -o /dev/null -w 'name_code=%{http_code}' https://example.com/ 2>/dev/null",
  'printf \' name_exit=%s\\n\' "$?"',
  "curl -s -g -m 5 -o /dev/null -w 'v6_code=%{http_code}' 'http://[2606:4700:4700::1111]/' 2>/dev/null",
  'printf \' v6_exit=%s\\n\' "$?"',
  "curl -s -k -m 5 -o /dev/null -w 'google_dns_code=%{http_code}' https://8.8.8.8/ 2>/dev/null",
  'printf \' google_dns_exit=%s\\n\' "$?"',
].join('; ');
const FIELD = /(\w+)=(\S+)/;

async function activeToken(): Promise<ModalToken> {
  const profiles = Bun.TOML.parse(
    await readFile(path.join(homedir(), '.modal.toml'), 'utf8'),
  ) as Record<string, { active?: boolean; token_id?: string; token_secret?: string }>;
  const chosen = Object.values(profiles).find((profile) => profile.active) ?? profiles.default;
  if (!chosen?.token_id || !chosen.token_secret)
    throw new Error('the active Modal profile has no token');
  return { tokenId: chosen.token_id, tokenSecret: chosen.token_secret };
}

/** What the suite did at Modal: every sandbox, how long it lived, and every error. */
function counted(inner: ModalTransport) {
  const sandboxes = new Map<string, { created: number; terminated: number | null }>();
  const errors: string[] = [];
  const hidden = new Set<string>();
  const noted = <T>(work: Promise<T>) =>
    work.catch((error: unknown) => {
      errors.push(`${String(error)} ${(error as Error).stack ?? ''}`);
      throw error;
    });
  const transport: ModalTransport = {
    async create(input, s) {
      const id = await noted(inner.create(input, s));
      sandboxes.set(id, { created: Date.now(), terminated: null });
      return id;
    },
    async start(id, exec, s) {
      const at = exec.argv.indexOf('melete-launch');
      if (at >= 0)
        for (let index = at + 2; exec.argv[index] === '-u'; index += 2)
          hidden.add(exec.argv[index + 1] ?? '');
      const running = await noted(inner.start(id, exec, s));
      return { finish: (max, finishSignal) => noted(running.finish(max, finishSignal)) };
    },
    async terminate(id, s) {
      await noted(inner.terminate(id, s));
      const entry = sandboxes.get(id);
      if (entry && entry.terminated === null) entry.terminated = Date.now();
    },
    poll: (id, s) => noted(inner.poll(id, s)),
    list: (appName, tags, s) => noted(inner.list(appName, tags, s)),
    close: () => inner.close(),
  };
  return { transport, sandboxes, errors, hidden };
}

if (!live) {
  test.skip('Modal live conformance needs MELETE_SANDBOX_LIVE=modal', () => {});
} else {
  const token = await activeToken();
  const secrets = [token.tokenId, token.tokenSecret];
  const counting = counted(createModalSdkTransport({ credential: (use) => use(token) }));
  const control = modalAcknowledgementControl(counting.transport);
  const provider = createModalProvider({ transport: control.transport, appName: APP });

  beforeAll(async () => {
    // Build the image before any sandbox exists, so no sandbox's lifetime is spent waiting on it.
    const { client } = await openModalClient({ credential: (use) => use(token) });
    try {
      const app = await client.apps.fromName(APP, { createIfMissing: true });
      const started = Date.now();
      await client.images.fromRegistry(IMAGE).build(app);
      log(`image ${IMAGE} ready in ${Math.round((Date.now() - started) / 1000)} s`);
    } finally {
      client.close();
    }
  }, 300_000);

  afterAll(async () => {
    // Whatever failed above, nothing this run created is left running.
    for (const [id, entry] of counting.sandboxes)
      if (entry.terminated === null)
        await counting.transport.terminate(id, signal()).catch(() => {});
    // Including one a killed process created but never reported: the app holds only these tests.
    const left = await counting.transport
      .list(APP, { melete_owner: 'v1' }, signal())
      .catch(() => []);
    for (const sandbox of left)
      await counting.transport.terminate(sandbox.sandboxId, signal()).catch(() => {});
    provider.close();
  }, 180_000);

  sandboxConformance(
    'modal live',
    async () => ({
      provider,
      image: IMAGE,
      secrets,
      loseNextAcknowledgement: control.lose,
      close: async () => {},
    }),
    { timeoutMs: 240_000, lifetimeSeconds: LIFETIME_SECONDS, reuseSandboxes: true, log },
  );

  test('a process with no Modal environment and no config file runs the deny-all probe through the adapter', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'melete-modal-live-home-'));
    const module = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
    const script = `
      const { existsSync } = await import('node:fs');
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { homedir, tmpdir } = await import('node:os');
      const path = await import('node:path');
      const { createModalProvider } = await import(${module('./modal.ts')});
      const { createModalSdkTransport } = await import(${module('./modal-sdk.ts')});
      const { openSandbox, sandboxLabels } = await import(${module('../manifest.ts')});
      const { runCommand } = await import(${module('../marker.ts')});
      const token = JSON.parse(await new Response(Bun.stdin.stream()).text());
      const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      say({
        config_file_present: existsSync(path.join(homedir(), '.modal.toml')),
        modal_variables_in_process: Object.keys(process.env).filter((key) => key.startsWith('MODAL_')).length,
      });
      const provider = createModalProvider({
        appName: ${JSON.stringify(APP)},
        transport: createModalSdkTransport({ credential: (use) => use(token) }),
      });
      const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-modal-probe-'));
      let handle = null;
      let created = 0;
      try {
        handle = await openSandbox(provider, {
          image: ${JSON.stringify(IMAGE)},
          egress: { kind: 'deny_all' },
          region: null,
          lifetimeSeconds: ${LIFETIME_SECONDS},
          idleSeconds: null,
          workdir: '/work',
          labels: sandboxLabels({ project: 'modal-live-probe', space: 'sp_LIVE', session: 'sbx_LIVEPROBE' }),
          env: {},
        }, AbortSignal.timeout(200_000));
        created = Date.now();
        say({ sandbox: handle.providerSandboxId });
        const probe = ${JSON.stringify(PROBE)};
        const result = await runCommand({
          provider,
          handle,
          request: { marker: 'act_01J0MODALLIVEPROBE000000', argv: ['sh', '-c', probe], timeoutMs: 60_000, dispatch: 'first' },
          workRoot,
          jobId: 'job_MODALLIVEPROBE',
          signal: AbortSignal.timeout(120_000),
        });
        say({
          outcome: result.outcome,
          probe: result.outcome === 'succeeded'
            ? Object.fromEntries([...new TextDecoder().decode(result.record.preview).matchAll(new RegExp(${JSON.stringify(FIELD.source)}, 'g'))].map((m) => [m[1], m[2]]))
            : null,
        });
      } catch (error) {
        say({ error: String(error && error.message) });
      } finally {
        if (handle) {
          const destroyed = await provider.destroy(handle, AbortSignal.timeout(60_000)).then(
            () => true,
            (error) => String(error && error.message),
          );
          say({ destroyed, alive_ms: Date.now() - created });
        }
        provider.close();
        await rm(workRoot, { recursive: true, force: true });
      }
      process.exit(0);
    `;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MODAL_')),
    ) as Record<string, string>;
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...env, HOME: home, USERPROFILE: home },
      stdin: new TextEncoder().encode(JSON.stringify(token)),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const killer = setTimeout(() => child.kill(), 280_000);
    let lines: Record<string, unknown>[] = [];
    try {
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      for (const secret of secrets) {
        expect(out.includes(secret)).toBe(false);
        expect(err.includes(secret)).toBe(false);
      }
      lines = out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const line of lines) log(`isolated process: ${JSON.stringify(line)}`);
      if (err.trim()) log(`isolated process stderr: ${err.trim().slice(0, 1_000)}`);
    } finally {
      clearTimeout(killer);
      const created = lines.find((line) => typeof line.sandbox === 'string')?.sandbox as
        | string
        | undefined;
      if (created) {
        const done = lines.find((line) => 'alive_ms' in line);
        const now = Date.now();
        counting.sandboxes.set(created, {
          created: now - Number(done?.alive_ms ?? 0),
          terminated: done?.destroyed === true ? now : null,
        });
      }
      await rm(home, { recursive: true, force: true });
    }
    const merged = Object.assign({}, ...lines) as {
      config_file_present?: boolean;
      modal_variables_in_process?: number;
      outcome?: string;
      probe?: Record<string, string> | null;
      destroyed?: unknown;
      error?: string;
    };
    expect(merged.error).toBeUndefined();
    expect(merged.config_file_present).toBe(false);
    expect(merged.modal_variables_in_process).toBe(0);
    expect(merged.outcome).toBe('succeeded');
    expect(merged.destroyed).toBe(true);
    const blocked = merged.probe ?? {};
    expect(blocked.dns).not.toBe('0');
    expect(blocked.dns).not.toBe('127');
    for (const prefix of ['v4', 'name', 'v6', 'google_dns']) {
      expect(blocked[`${prefix}_code`]).toBe('000');
      expect(['6', '7', '28', '35', '52', '56']).toContain(blocked[`${prefix}_exit`] ?? '');
    }
  }, 300_000);

  test('a Modal error for a rejected token carries neither half of it', async () => {
    const rejected: ModalToken = {
      tokenId: token.tokenId,
      tokenSecret: `as-${randomUUID().replaceAll('-', '')}`,
    };
    const transport = createModalSdkTransport({ credential: (use) => use(rejected) });
    const failure = await transport
      .list(APP, { melete_owner: 'v1' }, signal())
      .catch((error: unknown) => error);
    transport.close();
    expect(failure).toBeInstanceOf(ModalUnavailable);
    const text = `${String(failure)} ${(failure as Error).stack ?? ''}`;
    for (const secret of [...secrets, rejected.tokenSecret])
      expect(text.includes(secret)).toBe(false);
    log(`rejected token: ${String(failure).split('\n')[0]}`);
  }, 120_000);

  test('no sandbox from this run is left running, and no error carried the token', async () => {
    // The conformance suite's own clean-up runs when its block ends, before this.
    const list = () => counting.transport.list(APP, { melete_owner: 'v1' }, signal());
    let running = await list();
    // A termination can take a few seconds to reach the listing.
    for (let attempt = 0; running.length > 0 && attempt < 6; attempt += 1) {
      await Bun.sleep(5_000);
      running = await list();
    }
    const states: Record<string, string> = {};
    for (const id of counting.sandboxes.keys())
      states[id] = await counting.transport.poll(id, signal());
    log(`sandboxes created: ${counting.sandboxes.size}`);
    for (const [id, entry] of counting.sandboxes)
      log(
        `sandbox ${id}: ${entry.terminated === null ? 'not terminated by this run' : `alive ${Math.round((entry.terminated - entry.created) / 1000)} s`}, now ${states[id]}`,
      );
    log(`still running in ${APP}: ${running.length}`);
    log(`provider variables hidden from commands: ${JSON.stringify([...counting.hidden].sort())}`);
    log(`errors seen at the transport: ${counting.errors.length}`);
    expect(running).toEqual([]);
    for (const state of Object.values(states)) expect(state).not.toBe('running');
    expect(counting.sandboxes.size).toBeLessThanOrEqual(3);
    for (const error of counting.errors)
      for (const secret of secrets) expect(error.includes(secret)).toBe(false);
  }, 120_000);
}
