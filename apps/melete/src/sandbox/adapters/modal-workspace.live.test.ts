/**
 * A Modal workspace, live: write a file, suspend it as a filesystem snapshot,
 * resume it in a new sandbox and read the file back. Skipped unless
 * `MELETE_SANDBOX_LIVE=modal`.
 *
 * The token is read here, and only here, from the active profile in
 * `~/.modal.toml`, and reaches the adapter through its credential callback. It
 * is never printed, logged or written. Three sandboxes are created in the app
 * `melete-sandbox-conformance` with 0.125 CPU, 128 MiB and a five-minute
 * lifetime, one per stage of the chain; two snapshots are created and both are
 * deleted, and the first is deleted before the third sandbox is created from
 * the second, which is what says whether a snapshot chain survives deleting
 * the snapshot it came from. The run ends by listing the app and failing if
 * anything is still running.
 *
 * The resumed sandbox runs the deny-all probe again: persistence must not
 * widen what the workspace may reach. It also reports, in numbers only, what
 * the file named by `MODAL_CONTAINER_ARGUMENTS_PATH` holds, since a command in
 * the sandbox can read it: its size, whether it is JSON, and whether anything
 * in it is shaped like a credential. Its contents are never printed.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxLabels } from '../manifest.ts';
import { type ExecutionRecord, runCommand } from '../marker.ts';
import type { SandboxHandle, SandboxSpec } from '../types.ts';
import { createModalProvider } from './modal.ts';
import { createModalSdkTransport, openModalClient } from './modal-sdk.ts';
import type { ModalToken, ModalTransport } from './modal-transport.ts';

const live = process.env.MELETE_SANDBOX_LIVE === 'modal';
const APP = 'melete-sandbox-conformance';
const IMAGE = 'buildpack-deps:bookworm-curl';
const LIFETIME_SECONDS = 300;
/** Long enough for this run, short enough that a forgotten snapshot goes on its own. */
const SNAPSHOT_TTL_SECONDS = 3_600;
const signal = () => AbortSignal.timeout(120_000);
const begun = Date.now();
const log = (line: string) =>
  process.stdout.write(`modal workspace: ${((Date.now() - begun) / 1000).toFixed(1)}s ${line}\n`);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

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

/**
 * What the sandbox's own container-arguments file holds, in numbers only: its
 * size, its shape, and whether anything in it looks like a credential. The
 * file itself never leaves the sandbox.
 */
const ARGUMENTS_PROBE = [
  `p=$(tr '\\0' '\\n' < /proc/1/environ | sed -n 's/^MODAL_CONTAINER_ARGUMENTS_PATH=//p')`,
  'if [ -z "$p" ]; then printf \'variable=absent\\n\'; exit 0; fi',
  "printf 'variable=present\\n'",
  'if [ ! -f "$p" ]; then printf \'file=absent\\n\'; exit 0; fi',
  `printf 'size=%s ' "$(wc -c < "$p" | tr -d ' ')"`,
  `printf 'lines=%s ' "$(grep -a -c '' "$p" | tr -d ' ')"`,
  `printf 'first_byte=%s ' "$(od -An -tx1 -N1 < "$p" | tr -d ' ')"`,
  `printf 'token_shaped=%s ' "$(grep -a -c -E '(ak|as)-[A-Za-z0-9]{8,}' "$p" | tr -d ' ')"`,
  `printf 'jwt_shaped=%s ' "$(grep -a -c -E 'eyJ[A-Za-z0-9_-]{10,}[.]' "$p" | tr -d ' ')"`,
  `if head -c 1 "$p" | grep -q '{'; then`,
  `  printf 'json=yes keys=%s\\n' "$(grep -a -o '"[A-Za-z0-9_]\\{1,40\\}"[[:space:]]*:' "$p" | sort -u | tr -d '":' | tr '\\n' ',')"`,
  `else printf 'json=no keys=not-json\\n'; fi`,
].join('\n');

async function activeToken(): Promise<ModalToken> {
  const profiles = Bun.TOML.parse(
    await readFile(path.join(homedir(), '.modal.toml'), 'utf8'),
  ) as Record<string, { active?: boolean; token_id?: string; token_secret?: string }>;
  const chosen = Object.values(profiles).find((profile) => profile.active) ?? profiles.default;
  if (!chosen?.token_id || !chosen.token_secret)
    throw new Error('the active Modal profile has no token');
  return { tokenId: chosen.token_id, tokenSecret: chosen.token_secret };
}

/** Every sandbox and snapshot this run made, how long each lived, and every error. */
function counted(inner: ModalTransport) {
  const sandboxes = new Map<string, { created: number; terminated: number | null }>();
  const snapshots = new Map<string, { created: number; deleted: number | null }>();
  const errors: string[] = [];
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
    start: (id, exec, s) => noted(inner.start(id, exec, s)),
    async terminate(id, s) {
      await noted(inner.terminate(id, s));
      const entry = sandboxes.get(id);
      if (entry && entry.terminated === null) entry.terminated = Date.now();
    },
    poll: (id, s) => noted(inner.poll(id, s)),
    async snapshot(id, ttl, s) {
      const imageId = await noted(inner.snapshot(id, ttl, s));
      snapshots.set(imageId, { created: Date.now(), deleted: null });
      return imageId;
    },
    async deleteImage(imageId, s) {
      await noted(inner.deleteImage(imageId, s));
      const entry = snapshots.get(imageId);
      if (entry && entry.deleted === null) entry.deleted = Date.now();
    },
    list: (appName, tags, s) => noted(inner.list(appName, tags, s)),
    close: () => inner.close(),
  };
  return { transport, sandboxes, snapshots, errors };
}

if (!live) {
  test.skip('Modal live workspaces need MELETE_SANDBOX_LIVE=modal', () => {});
} else {
  const token = await activeToken();
  const secrets = [token.tokenId, token.tokenSecret];
  const counting = counted(createModalSdkTransport({ credential: (use) => use(token) }));
  const provider = createModalProvider({
    transport: counting.transport,
    appName: APP,
    snapshotTtlSeconds: SNAPSHOT_TTL_SECONDS,
  });
  const fields = (record: ExecutionRecord) =>
    Object.fromEntries(
      [...text(record.preview).matchAll(/(\w+)=(\S*)/g)].map((match) => [match[1], match[2]]),
    );
  const spec = (session: string): SandboxSpec => ({
    image: IMAGE,
    egress: { kind: 'deny_all' },
    region: null,
    lifetimeSeconds: LIFETIME_SECONDS,
    idleSeconds: null,
    workdir: '/work',
    labels: sandboxLabels({ project: 'modal-workspace', space: 'sp_LIVEWS', session }),
    env: {},
  });
  let workRoot = '';

  const ran = async (handle: SandboxHandle, marker: string, argv: string[]) => {
    const result = await runCommand({
      provider,
      handle,
      request: { marker, argv, timeoutMs: 90_000, dispatch: 'first' },
      workRoot,
      jobId: 'job_LIVEWORKSPACE',
      signal: AbortSignal.timeout(180_000),
    });
    if (result.outcome !== 'succeeded') throw new Error(JSON.stringify(result));
    return result.record;
  };

  beforeAll(async () => {
    log('building the image');
    workRoot = await mkdtemp(path.join(tmpdir(), 'melete-modal-workspace-'));
    const { client } = await openModalClient({ credential: (use) => use(token) });
    try {
      const app = await client.apps.fromName(APP, { createIfMissing: true });
      await client.images.fromRegistry(IMAGE).build(app);
      log('image ready');
    } finally {
      client.close();
    }
  }, 300_000);

  afterAll(async () => {
    for (const [id, entry] of counting.sandboxes)
      if (entry.terminated === null)
        await counting.transport.terminate(id, signal()).catch(() => {});
    const left = await counting.transport
      .list(APP, { melete_owner: 'v1' }, signal())
      .catch(() => []);
    for (const sandbox of left)
      await counting.transport.terminate(sandbox.sandboxId, signal()).catch(() => {});
    for (const [imageId, entry] of counting.snapshots)
      if (entry.deleted === null)
        await counting.transport.deleteImage(imageId, signal()).catch(() => {});
    provider.close();
    await rm(workRoot, { recursive: true, force: true });
  }, 300_000);

  test('a workspace suspended as a snapshot comes back with its files and stays denied the network', async () => {
    const snapshot = provider.snapshot as NonNullable<typeof provider.snapshot>;
    const resume = provider.resume as NonNullable<typeof provider.resume>;
    const forget = provider.deleteSnapshot as NonNullable<typeof provider.deleteSnapshot>;
    log('creating the first sandbox');
    const first = await provider.create(spec('sbx_LIVEWS1'), signal());
    log(`first sandbox ${first.providerSandboxId}`);
    await ran(first, 'act_01J0LIVEWSWRITE00000001', [
      'sh',
      '-c',
      "printf remembered > /work/kept.txt; printf '%s' ok",
    ]);
    // What a command in the sandbox can read of Modal's own container arguments.
    const arguments_ = fields(
      await ran(first, 'act_01J0LIVEWSARGUMENTS0001', ['sh', '-c', ARGUMENTS_PROBE]),
    );
    log(`container arguments: ${JSON.stringify(arguments_)}`);
    log('snapshotting the first sandbox');
    const { snapshotRef: firstSnapshot } = await snapshot(first, signal());
    log(`first snapshot ${firstSnapshot}`);
    await provider.destroy(first, signal());
    const second = await resume(firstSnapshot, spec('sbx_LIVEWS2'), signal());
    log(`second sandbox ${second.providerSandboxId}`);
    expect(second.providerSandboxId).not.toBe(first.providerSandboxId);
    expect(text(await provider.getFile(second, '/work/kept.txt', 64, signal()))).toBe('remembered');
    const blocked = fields(await ran(second, 'act_01J0LIVEWSPROBE00000001', ['sh', '-c', PROBE]));
    log(`resumed deny_all probe: ${JSON.stringify(blocked)}`);
    expect(blocked.dns).not.toBe('0');
    expect(blocked.dns).not.toBe('127');
    for (const prefix of ['v4', 'name', 'v6', 'google_dns']) {
      expect(blocked[`${prefix}_code`]).toBe('000');
      expect(['6', '7', '28', '35', '52', '56']).toContain(blocked[`${prefix}_exit`] ?? '');
    }
    await ran(second, 'act_01J0LIVEWSWRITE00000002', [
      'sh',
      '-c',
      "printf again > /work/second.txt; printf '%s' ok",
    ]);
    const { snapshotRef: secondSnapshot } = await snapshot(second, signal());
    log(`second snapshot ${secondSnapshot}`);
    await provider.destroy(second, signal());
    // The snapshot the second sandbox came from goes before the third is created
    // from the second snapshot: a chain must not depend on what it came from.
    await forget(firstSnapshot, signal());
    log('the first snapshot is deleted before the third sandbox is created');
    const third = await resume(secondSnapshot, spec('sbx_LIVEWS3'), signal());
    log(`third sandbox ${third.providerSandboxId}`);
    expect(text(await provider.getFile(third, '/work/kept.txt', 64, signal()))).toBe('remembered');
    expect(text(await provider.getFile(third, '/work/second.txt', 64, signal()))).toBe('again');
    await provider.destroy(third, signal());
    await forget(secondSnapshot, signal());
    // Deleting twice is not an error, and Modal no longer has either image.
    await forget(secondSnapshot, signal());
    const { client } = await openModalClient({ credential: (use) => use(token) });
    try {
      for (const imageId of [firstSnapshot, secondSnapshot]) {
        const found = await client.images.fromId(imageId).then(
          () => 'still there',
          (error: unknown) => (error as Error).name,
        );
        expect(found).toBe('NotFoundError');
      }
    } finally {
      client.close();
    }
  }, 300_000);

  test('nothing from this run is left at Modal, and no error carried the token', async () => {
    const list = () => counting.transport.list(APP, { melete_owner: 'v1' }, signal());
    let running = await list();
    for (let attempt = 0; running.length > 0 && attempt < 6; attempt += 1) {
      await Bun.sleep(5_000);
      running = await list();
    }
    log(`sandboxes created: ${counting.sandboxes.size}`);
    for (const [id, entry] of counting.sandboxes)
      log(
        `sandbox ${id}: ${
          entry.terminated === null
            ? 'not terminated by this run'
            : `alive ${Math.round((entry.terminated - entry.created) / 1000)} s`
        }, now ${await counting.transport.poll(id, signal())}`,
      );
    log(`snapshots created: ${counting.snapshots.size}`);
    for (const [imageId, entry] of counting.snapshots)
      log(`snapshot ${imageId}: ${entry.deleted === null ? 'not deleted' : 'deleted'}`);
    log(`still running in ${APP}: ${running.length}`);
    log(`errors seen at the transport: ${counting.errors.length}`);
    expect(running).toEqual([]);
    expect(counting.sandboxes.size).toBeLessThanOrEqual(3);
    for (const [, entry] of counting.snapshots) expect(entry.deleted).not.toBeNull();
    for (const error of counting.errors)
      for (const secret of secrets) expect(error.includes(secret)).toBe(false);
  }, 180_000);
}
