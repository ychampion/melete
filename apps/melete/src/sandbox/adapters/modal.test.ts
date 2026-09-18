import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabase } from '../../../test/helpers/database.ts';
import { sandboxConformance } from '../conformance.ts';
import { openSandbox, type SandboxRefusal, sandboxLabels } from '../manifest.ts';
import { runCommand } from '../marker.ts';
import {
  type EgressPolicy,
  SandboxAdapterRefusal,
  SandboxGone,
  type SandboxHandle,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import { workspaceConformance } from '../workspace-conformance.ts';
import { createModalProvider, providerVariables } from './modal.ts';
import {
  createModalSdkTransport,
  MODAL_SERVER,
  profileMismatch,
  scrubModalError,
} from './modal-sdk.ts';
import { createModalStandin, MODAL_STANDIN_EVIDENCE } from './modal-standin.ts';
import {
  type ModalCreate,
  type ModalExec,
  ModalNotFound,
  ModalStartRefused,
  type ModalToken,
  type ModalTransport,
  ModalUnavailable,
  modalAcknowledgementControl,
} from './modal-transport.ts';

/**
 * Nothing here reaches Modal. The conformance run goes through an authored
 * stand-in at the transport seam, which is weaker evidence than an HTTP
 * replay; `modal.live.test.ts` is the evidence about Modal itself.
 */
const TOKEN: ModalToken = {
  tokenId: 'ak-standinTokenIdThatMustNeverLeak01',
  tokenSecret: 'as-standinTokenSecretThatMustNeverLeak01',
};
const SECRETS = [TOKEN.tokenId, TOKEN.tokenSecret];
const APP = 'melete-sandbox-conformance';
const signal = () => AbortSignal.timeout(60_000);
const database = await testDatabase();
afterAll(async () => database?.close());

const spec = (egress: EgressPolicy = { kind: 'deny_all' }): SandboxSpec => ({
  image: 'debian:bookworm-slim',
  egress,
  region: null,
  lifetimeSeconds: 600,
  idleSeconds: null,
  workdir: '/work',
  labels: sandboxLabels({ project: 'modal-test', space: 'sp_MODAL', session: 'sbx_MODAL' }),
  env: {},
});

/** A transport that records what the adapter asked for on the way through. */
function recording(inner: ModalTransport) {
  const creates: ModalCreate[] = [];
  const starts: ModalExec[] = [];
  const transport: ModalTransport = {
    ...inner,
    create: (input, s) => {
      creates.push(input);
      return inner.create(input, s);
    },
    start: (id, exec, s) => {
      starts.push(exec);
      return inner.start(id, exec, s);
    },
  };
  return { transport, creates, starts };
}

sandboxConformance(`modal: ${MODAL_STANDIN_EVIDENCE}`, async () => {
  // Stands for whatever variables Modal sets; the live run records which it does.
  const standin = createModalStandin({ injected: { MODAL_TASK_ID: 'ta-standin' } });
  const control = modalAcknowledgementControl(standin.transport);
  return {
    provider: createModalProvider({ transport: control.transport, appName: APP }),
    image: 'debian:bookworm-slim',
    secrets: SECRETS,
    loseNextAcknowledgement: control.lose,
    close: async () => {},
  };
});

workspaceConformance(`modal: ${MODAL_STANDIN_EVIDENCE}`, {
  sql: database?.sql ?? null,
  open: async () => {
    const standin = createModalStandin({ injected: { MODAL_TASK_ID: 'ta-standin' } });
    return {
      provider: createModalProvider({ transport: standin.transport, appName: APP }),
      persistence: 'snapshot',
      image: 'debian:bookworm-slim',
      failNextSuspend: () => standin.failNextSnapshot(),
      snapshotHeld: async (ref) => standin.engine.snapshots.has(ref),
      replayed: false,
      close: async () => {},
    };
  },
});

test('a workspace snapshot has an explicit expiry and comes back as a new deny-all sandbox with its files', async () => {
  const standin = createModalStandin();
  const { transport, creates } = recording(standin.transport);
  const provider = createModalProvider({
    transport,
    appName: APP,
    snapshotTtlSeconds: 7 * 24 * 3600,
  });
  const snapshot = provider.snapshot as NonNullable<typeof provider.snapshot>;
  const resume = provider.resume as NonNullable<typeof provider.resume>;
  const deleteSnapshot = provider.deleteSnapshot as NonNullable<typeof provider.deleteSnapshot>;
  const handle = await openSandbox(provider, spec(), signal());
  await provider.putFiles(
    handle,
    (async function* () {
      yield { path: '/work/kept.txt', bytes: new TextEncoder().encode('kept'), mode: 0o644 };
    })(),
    signal(),
  );
  const { snapshotRef } = await snapshot(handle, signal());
  expect(standin.expiries.get(snapshotRef)).toBe(7 * 24 * 3600);
  // Taking the snapshot does not stop the sandbox; the session layer does.
  expect(await provider.inspect(handle, signal())).toBe('running');
  await provider.destroy(handle, signal());
  const next = {
    ...spec(),
    labels: sandboxLabels({ project: 'modal-test', space: 'sp_MODAL', session: 'sbx_MODALNEXT' }),
  };
  const resumed = await resume(snapshotRef, next, signal());
  expect(resumed.providerSandboxId).not.toBe(handle.providerSandboxId);
  expect(creates.at(-1)).toMatchObject({
    image: snapshotRef,
    imageKind: 'snapshot',
    blockNetwork: true,
    outboundCidrAllowlist: null,
    tags: { melete_session: 'sbx_MODALNEXT' },
  });
  const kept = await provider.getFile(resumed, '/work/kept.txt', 64, signal());
  expect(new TextDecoder().decode(kept)).toBe('kept');
  await deleteSnapshot(snapshotRef, signal());
  // Deleting again is not an error, and a deleted snapshot cannot be resumed.
  await deleteSnapshot(snapshotRef, signal());
  const gone = await resume(snapshotRef, next, signal()).catch((error: unknown) => error);
  expect(gone).toBeInstanceOf(SandboxGone);
  expect([...standin.engine.sandboxes.keys()]).toEqual([resumed.providerSandboxId]);
  await provider.destroy(resumed, signal());
  expect(() => createModalProvider({ transport, appName: APP, snapshotTtlSeconds: 0 })).toThrow();
});

test('deny-all is sent as blockNetwork, a CIDR allow-list as outboundCidrAllowlist, and nothing else is offered', async () => {
  const standin = createModalStandin();
  const { transport, creates } = recording(standin.transport);
  const provider = createModalProvider({ transport, appName: APP });
  for (const egress of [
    { kind: 'deny_all' },
    { kind: 'cidr_allowlist', cidrs: ['203.0.113.0/24'] },
    { kind: 'open' },
  ] satisfies EgressPolicy[]) {
    const handle = await openSandbox(provider, spec(egress), signal());
    await provider.destroy(handle, signal());
  }
  expect(creates.map((input) => [input.blockNetwork, input.outboundCidrAllowlist])).toEqual([
    [true, null],
    [false, ['203.0.113.0/24']],
    [false, null],
  ]);
  expect(creates[0]).toMatchObject({
    appName: APP,
    cpu: 0.125,
    memoryMiB: 128,
    timeoutMs: 600_000,
    idleTimeoutMs: null,
    tags: { melete_owner: 'v1', melete_project: 'modal-test', melete_session: 'sbx_MODAL' },
  });
  const refused = await openSandbox(
    provider,
    spec({ kind: 'domain_allowlist', domains: ['example.com'] }),
    signal(),
  ).catch((error: unknown) => error);
  expect((refused as SandboxRefusal).code).toBe('egress_unsupported');
  const direct = await provider
    .create(spec({ kind: 'domain_allowlist', domains: ['example.com'] }), signal())
    .catch((error: unknown) => error);
  expect(String(direct)).toContain('cannot enforce');
  expect(creates).toHaveLength(3);
  expect(standin.engine.sandboxes.size).toBe(0);
});

test('a provider variable in the sandbox never reaches a command, and its value never leaves the sandbox', async () => {
  const standin = createModalStandin({
    injected: { MODAL_TASK_ID: 'ta-value-stays-inside', MODAL_IMAGE_ID: 'im-value-stays-inside' },
  });
  const { transport, starts } = recording(standin.transport);
  const provider = createModalProvider({ transport, appName: APP });
  const handle = await openSandbox(provider, spec(), signal());
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-modal-env-'));
  try {
    const result = await runCommand({
      provider,
      handle,
      request: {
        marker: 'act_01J0MODALENV00000000000',
        argv: ['env'],
        timeoutMs: 20_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_MODALENV',
      signal: signal(),
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    const seen = new TextDecoder().decode(result.record.preview);
    expect(seen).toContain('PATH=');
    expect(seen).not.toContain('MODAL_');
    const launched = starts.find((exec) => exec.argv.includes('melete-launch'));
    expect(launched?.argv).toContain('MODAL_TASK_ID');
    expect(launched?.argv.join(' ')).not.toContain('value-stays-inside');
  } finally {
    await provider.destroy(handle, signal());
    await rm(workRoot, { recursive: true, force: true });
  }
  expect(providerVariables(new TextEncoder().encode('A=1\nMODAL_X=2\nB=x\nMODAL_Y=\n'))).toEqual([
    'MODAL_X',
    'MODAL_Y',
  ]);
});

test('what the transport says about a start decides whether the command may run again', async () => {
  const standin = createModalStandin();
  let answer: 'refuse' | 'lose' | 'drop' | null = null;
  let marked = 0;
  const transport: ModalTransport = {
    ...standin.transport,
    async start(id, exec, s) {
      if (!exec.argv.includes('melete-launch')) return standin.transport.start(id, exec, s);
      marked += 1;
      if (answer === 'refuse')
        throw new ModalStartRefused('the command line is longer than Modal accepts');
      if (answer === 'lose') throw new ModalUnavailable('UNAVAILABLE: connection reset');
      const running = await standin.transport.start(id, exec, s);
      if (answer !== 'drop') return running;
      return {
        async finish() {
          throw new ModalUnavailable('stream closed');
        },
      };
    },
  };
  const provider = createModalProvider({ transport, appName: APP });
  const handle = await openSandbox(provider, spec(), signal());
  const exec = (marker: string) =>
    provider.exec(
      handle,
      { marker, argv: ['true'], cwd: '/work', timeoutMs: 5_000, maxOutputBytes: 1024 },
      signal(),
    );
  try {
    answer = 'refuse';
    expect(await exec('act_A').catch((error: unknown) => error)).toBeInstanceOf(
      SandboxStartRefused,
    );
    answer = 'lose';
    const lost = await exec('act_B').catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(SandboxTransportError);
    expect((lost as SandboxTransportError).started).toBe('unknown');
    answer = 'drop';
    const dropped = await exec('act_C').catch((error: unknown) => error);
    expect((dropped as SandboxTransportError).started).toBe('yes');
    expect(marked).toBe(3);
  } finally {
    await provider.destroy(handle, signal());
  }
  // With no way to learn the sandbox's variables, the command is never sent.
  const blind = createModalStandin();
  const handleOf = (id: string): SandboxHandle => ({
    providerSandboxId: id,
    imageDigest: null,
    region: null,
  });
  const created = await blind.transport.create(
    {
      appName: APP,
      image: 'debian:bookworm-slim',
      imageKind: 'registry',
      cpu: 0.125,
      memoryMiB: 128,
      timeoutMs: 60_000,
      idleTimeoutMs: null,
      blockNetwork: true,
      outboundCidrAllowlist: null,
      env: {},
      tags: {},
    },
    signal(),
  );
  let sent = 0;
  const unreachable = createModalProvider({
    appName: APP,
    transport: {
      ...blind.transport,
      async start(id, execSpec, s) {
        if (execSpec.argv.includes('melete-launch')) sent += 1;
        else throw new ModalUnavailable('DEADLINE_EXCEEDED');
        return blind.transport.start(id, execSpec, s);
      },
    },
  });
  const refused = await unreachable
    .exec(
      handleOf(created),
      { marker: 'act_D', argv: ['true'], cwd: '/work', timeoutMs: 5_000, maxOutputBytes: 1024 },
      signal(),
    )
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(SandboxStartRefused);
  expect(String(refused)).toContain('was not sent');
  expect(sent).toBe(0);
  blind.engine.destroy(created);
});

test("reconcile terminates only this installation's labelled orphans and leaves foreign sandboxes alone", async () => {
  // The listing ignores the tag filter here, so the adapter's own ownership
  // check is what stands between it and a stranger's sandbox.
  const standin = createModalStandin();
  const provider = createModalProvider({
    appName: APP,
    transport: {
      ...standin.transport,
      list: (appName, _tags, s) => standin.transport.list(appName, {}, s),
    },
  });
  const make = (tags: Record<string, string>) =>
    standin.engine.create({
      image: 'x',
      egress: { kind: 'deny_all' },
      labels: tags,
      env: {},
      lifetimeSeconds: 600,
    }).id;
  const tagged = (labels: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(labels).map(([key, value]) => [key.replaceAll('.', '_'), value]),
    );
  const one = make(
    tagged(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ONE' })),
  );
  const orphan = make(
    tagged(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_ORPHAN' })),
  );
  const live = make(
    tagged(sandboxLabels({ project: 'install-a', space: 'sp_A', session: 'sbx_LIVE' })),
  );
  const other = make(
    tagged(sandboxLabels({ project: 'install-b', space: 'sp_B', session: 'sbx_OTHER' })),
  );
  const bare = make({});
  const unowned = make({ melete_project: 'install-a', melete_session: 'sbx_NOOWNER' });
  const destroyed = await provider.reconcile(
    'install-a',
    new Set([one, 'sbx_LIVE']),
    signal(),
    null,
  );
  expect(destroyed).toEqual([orphan]);
  expect([...standin.engine.sandboxes.keys()].sort()).toEqual(
    [one, live, other, bare, unowned].sort(),
  );
});

test('stdin reaches a marked command once', async () => {
  const standin = createModalStandin();
  const provider = createModalProvider({ transport: standin.transport, appName: APP });
  const handle = await openSandbox(provider, spec(), signal());
  const workRoot = await mkdtemp(path.join(tmpdir(), 'melete-modal-stdin-'));
  try {
    const result = await runCommand({
      provider,
      handle,
      request: {
        marker: 'act_01J0MODALSTDIN000000000',
        argv: ['cat'],
        stdin: new TextEncoder().encode('from stdin'),
        timeoutMs: 20_000,
        dispatch: 'first',
      },
      workRoot,
      jobId: 'job_MODALSTDIN',
      signal: signal(),
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded')
      expect(new TextDecoder().decode(result.record.preview)).toBe('from stdin');
  } finally {
    await provider.destroy(handle, signal());
    await rm(workRoot, { recursive: true, force: true });
  }
});

/** An SDK double: the calls the transport makes, and the profile a real client would resolve. */
function sdkDouble(behaviour: {
  profile?: Partial<Record<string, unknown>>;
  exec?: (argv: string[]) => Promise<unknown>;
  create?: () => Promise<unknown>;
  missingImage?: boolean;
}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const bytes = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  const notFound = () =>
    Object.assign(new Error('Could not find image with ID im-double'), { name: 'NotFoundError' });
  const sandbox = (id: string) => ({
    sandboxId: id,
    detach() {},
    snapshotFilesystem: async (params: unknown) => {
      calls.push({ method: 'snapshotFilesystem', args: [params] });
      return { imageId: 'im-double' };
    },
    exec: async (argv: string[], params: unknown) => {
      calls.push({ method: 'exec', args: [argv, params] });
      if (behaviour.exec) await behaviour.exec(argv);
      const written: Uint8Array[] = [];
      return {
        stdin: new WritableStream<Uint8Array>({
          write(chunk) {
            written.push(chunk);
          },
          close() {
            calls.push({ method: 'stdin.close', args: [Buffer.concat(written).toString()] });
          },
        }),
        stdout: bytes('0123456789'),
        stderr: bytes('err'),
        wait: async () => 7,
      };
    },
  });
  class ModalClient {
    readonly profile: Record<string, unknown>;
    readonly apps = {
      fromName: async (...args: unknown[]) => {
        calls.push({ method: 'apps.fromName', args });
        return { appId: 'ap-double' };
      },
    };
    readonly images = {
      fromRegistry: (tag: string) => ({ tag }),
      fromId: async (imageId: string) => {
        calls.push({ method: 'images.fromId', args: [imageId] });
        if (behaviour.missingImage) throw notFound();
        return { imageId };
      },
      delete: async (imageId: string) => {
        calls.push({ method: 'images.delete', args: [imageId] });
        if (behaviour.missingImage) throw notFound();
      },
    };
    readonly sandboxes = {
      create: async (...args: unknown[]) => {
        calls.push({ method: 'sandboxes.create', args });
        if (behaviour.create) await behaviour.create();
        return sandbox('sb-double');
      },
      fromId: async (id: string) => sandbox(id),
    };
    constructor(params: Record<string, unknown>) {
      calls.push({ method: 'new', args: [Object.keys(params).sort()] });
      this.profile = {
        serverUrl: MODAL_SERVER,
        tokenId: params.tokenId,
        tokenSecret: params.tokenSecret,
        environment: params.environment,
        maxThrottleWaitSecs: params.maxThrottleWaitSecs,
        sandboxChannelIdleTimeoutMs: 30_000,
        sandboxV2: false,
        ...behaviour.profile,
      };
    }
    close() {}
  }
  return { calls, load: async () => ({ ModalClient }) as never };
}

test('the SDK transport asks Modal for deny-all without an identity token, and reads a process to its end', async () => {
  const double = sdkDouble({});
  const transport = createModalSdkTransport({ credential: (use) => use(TOKEN), load: double.load });
  await transport.create(
    {
      appName: APP,
      image: 'debian:bookworm-slim',
      imageKind: 'registry',
      cpu: 0.125,
      memoryMiB: 128,
      timeoutMs: 300_000,
      idleTimeoutMs: null,
      blockNetwork: true,
      outboundCidrAllowlist: null,
      env: {},
      tags: { melete_owner: 'v1' },
    },
    signal(),
  );
  const created = double.calls.find((call) => call.method === 'sandboxes.create')?.args[2];
  expect(created).toEqual({
    cpu: 0.125,
    memoryMiB: 128,
    timeoutMs: 300_000,
    blockNetwork: true,
    tags: { melete_owner: 'v1' },
    includeOidcIdentityToken: false,
  });
  const running = await transport.start(
    'sb-double',
    { argv: ['cat'], timeoutSeconds: 31, stdin: new TextEncoder().encode('in') },
    signal(),
  );
  const finished = await running.finish(4, signal());
  expect(finished.exitCode).toBe(7);
  expect(new TextDecoder().decode(finished.stdout)).toBe('0123');
  expect(new TextDecoder().decode(finished.stderr)).toBe('err');
  expect(finished.totalBytes).toBe(13);
  expect(double.calls.find((call) => call.method === 'exec')?.args[1]).toEqual({
    mode: 'binary',
    stdout: 'pipe',
    stderr: 'pipe',
    timeoutMs: 31_000,
  });
  expect(double.calls.find((call) => call.method === 'stdin.close')?.args).toEqual(['in']);
  // The client is built from explicit settings only.
  expect(double.calls[0]?.args[0]).toEqual([
    'logLevel',
    'logger',
    'maxThrottleWaitSecs',
    'tokenId',
    'tokenSecret',
  ]);
  transport.close();
});

test('only what fails before a request leaves is a refused start', async () => {
  const double = sdkDouble({
    exec: async () => {
      throw Object.assign(
        new Error(
          '/modal.task_command_router.TaskCommandRouter/TaskExecStart FAILED_PRECONDITION: no',
        ),
        {
          name: 'ClientError',
          code: 9,
        },
      );
    },
  });
  const transport = createModalSdkTransport({ credential: (use) => use(TOKEN), load: double.load });
  const tooLong = await transport
    .start('sb-double', { argv: ['x'.repeat(70_000)], timeoutSeconds: 31 }, signal())
    .catch((error: unknown) => error);
  expect(tooLong).toBeInstanceOf(ModalStartRefused);
  expect(double.calls.some((call) => call.method === 'exec')).toBe(false);
  // Modal retries a start under one exec id, so even a definite-looking answer
  // cannot prove an earlier attempt did not start the process.
  const answered = await transport
    .start('sb-double', { argv: ['true'], timeoutSeconds: 31 }, signal())
    .catch((error: unknown) => error);
  expect(answered).toBeInstanceOf(ModalUnavailable);
  expect(answered).not.toBeInstanceOf(ModalStartRefused);
  transport.close();
});

test('a client whose profile came from outside the adapter is refused before it sends anything', async () => {
  for (const [profile, named] of [
    [{ serverUrl: 'https://modal.example.test:443' }, 'the server address'],
    [{ environment: 'from-the-file' }, 'the environment'],
    [{ sandboxV2: true }, 'the sandbox backend'],
    [{ imageBuilderVersion: '2024.10' }, 'the image builder version'],
    [{ oauthClientId: 'oc-from-env' }, 'OAuth settings'],
    [{ sandboxChannelIdleTimeoutMs: 0 }, 'the connection idle timeout'],
  ] as const) {
    const double = sdkDouble({ profile });
    const transport = createModalSdkTransport({
      credential: (use) => use(TOKEN),
      load: double.load,
    });
    const refused = await transport.list(APP, {}, signal()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SandboxAdapterRefusal);
    expect(String(refused)).toContain(named);
    for (const secret of SECRETS) expect(String(refused)).not.toContain(secret);
    expect(double.calls.map((call) => call.method)).toEqual(['new']);
    const provider = createModalProvider({ transport, appName: APP });
    const execRefused = await provider
      .exec(
        { providerSandboxId: 'sb-double', imageDigest: null, region: null },
        { marker: 'act_E', argv: ['true'], cwd: '/work', timeoutMs: 1_000, maxOutputBytes: 64 },
        signal(),
      )
      .catch((error: unknown) => error);
    // A refusal of the client itself is permanent and is not a retry.
    expect(execRefused).toBeInstanceOf(SandboxAdapterRefusal);
    transport.close();
  }
  expect(
    profileMismatch(
      {
        serverUrl: MODAL_SERVER,
        tokenId: TOKEN.tokenId,
        tokenSecret: TOKEN.tokenSecret,
        maxThrottleWaitSecs: 60,
        sandboxChannelIdleTimeoutMs: 30_000,
        sandboxV2: false,
      },
      TOKEN,
      undefined,
    ),
  ).toBeNull();
});

test('a Modal error never carries the token', async () => {
  const echo = `UNAUTHENTICATED: token ${TOKEN.tokenId}:${TOKEN.tokenSecret} rejected; also ak-someOtherTokenId123 as-someOtherSecret456`;
  const double = sdkDouble({
    create: async () => {
      throw Object.assign(new Error(echo), {
        name: 'ClientError',
        code: 16,
        details: TOKEN.tokenSecret,
      });
    },
    exec: async () => {
      throw new Error(echo);
    },
  });
  const transport = createModalSdkTransport({ credential: (use) => use(TOKEN), load: double.load });
  const provider = createModalProvider({ transport, appName: APP });
  const failures: unknown[] = [];
  failures.push(await provider.create(spec(), signal()).catch((error: unknown) => error));
  failures.push(
    await provider
      .exec(
        { providerSandboxId: 'sb-double', imageDigest: null, region: null },
        { marker: 'act_F', argv: ['true'], cwd: '/work', timeoutMs: 1_000, maxOutputBytes: 64 },
        signal(),
      )
      .catch((error: unknown) => error),
  );
  failures.push(
    await transport
      .start('sb-double', { argv: ['true'], timeoutSeconds: 31 }, signal())
      .catch((error: unknown) => error),
  );
  for (const failure of failures) {
    const text = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack ?? ''}`;
    expect(text).toContain('[redacted]');
    for (const secret of [...SECRETS, 'ak-someOtherTokenId123', 'as-someOtherSecret456'])
      expect(text).not.toContain(secret);
  }
  // The token itself is removed whatever its shape, not only by the pattern.
  expect(scrubModalError(new Error('x plain-secret-value y'), ['plain-secret-value'])).toBe(
    'Error: x [redacted] y',
  );
  transport.close();
});

test('a sandbox the adapter cannot prepare is terminated, not left running', async () => {
  const standin = createModalStandin();
  const provider = createModalProvider({
    appName: APP,
    transport: {
      ...standin.transport,
      start: async () => {
        throw new ModalUnavailable('UNAVAILABLE: the command router did not answer');
      },
    },
  });
  const failed = await provider.create(spec(), signal()).catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(SandboxTransportError);
  expect(standin.engine.sandboxes.size).toBe(0);
});

test('the adapter and its transports read no credential or setting from the environment or a config file', async () => {
  for (const file of [
    './modal.ts',
    './modal-sdk.ts',
    './modal-transport.ts',
    './modal-standin.ts',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toContain('process.env');
    expect(source).not.toContain('Bun.env');
    expect(source).not.toContain('homedir');
    expect(source).not.toMatch(/readFile|node:fs/);
    expect(source).not.toContain('MODAL_TOKEN');
  }
});

test('with no Modal environment and no config file, the SDK client takes everything from the adapter, and a redirect is refused', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'melete-modal-home-'));
  try {
    const redirect = path.join(home, 'redirect.toml');
    await writeFile(
      redirect,
      '[redirected]\nactive = true\nserver_url = "https://127.0.0.1:9"\ntoken_id = "ak-fromTheFile000000"\ntoken_secret = "as-fromTheFile000000"\n',
    );
    const script = `
      const { openModalClient } = await import(${JSON.stringify(new URL('./modal-sdk.ts', import.meta.url).href)});
      const token = JSON.parse(await new Response(Bun.stdin.stream()).text());
      const outcomes = {};
      const attempt = async (name) => {
        try {
          const { client } = await openModalClient({ credential: (use) => use(token) });
          outcomes[name] = { ok: client.profile.serverUrl };
          client.close();
        } catch (error) {
          outcomes[name] = { refused: String(error.message) };
        }
      };
      await attempt('bare');
      process.env.MODAL_TOKEN_ID = 'ak-fromTheEnvironment00';
      process.env.MODAL_TOKEN_SECRET = 'as-fromTheEnvironment00';
      await attempt('token_in_environment');
      delete process.env.MODAL_TOKEN_ID;
      delete process.env.MODAL_TOKEN_SECRET;
      for (const [name, key, value] of [
        ['server', 'MODAL_SERVER_URL', 'https://127.0.0.1:9'],
        ['environment', 'MODAL_ENVIRONMENT', 'elsewhere'],
        ['backend', 'MODAL_SANDBOX_V2', '1'],
      ]) {
        process.env[key] = value;
        await attempt(name);
        delete process.env[key];
      }
      process.stdout.write(JSON.stringify(outcomes));
    `;
    const run = async (extra: Record<string, string>) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('MODAL_')),
      ) as Record<string, string>;
      const child = Bun.spawn([process.execPath, '-e', script], {
        env: { ...env, HOME: home, USERPROFILE: home, ...extra },
        stdin: new TextEncoder().encode(JSON.stringify(TOKEN)),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err: err.slice(0, 2_000) }).toEqual({ code: 0, err: '' });
      for (const secret of SECRETS) expect(out + err).not.toContain(secret);
      return JSON.parse(out) as Record<string, { ok?: string; refused?: string }>;
    };
    const absent = await run({});
    expect(absent).toEqual({
      bare: { ok: MODAL_SERVER },
      token_in_environment: { ok: MODAL_SERVER },
      server: { refused: expect.stringContaining('the server address') },
      environment: { refused: expect.stringContaining('the environment') },
      backend: { refused: expect.stringContaining('the sandbox backend') },
    });
    const redirected = await run({ MODAL_CONFIG_PATH: redirect });
    expect(redirected.bare).toEqual({ refused: expect.stringContaining('the server address') });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test('the SDK transport snapshots with an explicit expiry, resumes from the image, and reports a missing image as not found', async () => {
  const double = sdkDouble({});
  const transport = createModalSdkTransport({ credential: (use) => use(TOKEN), load: double.load });
  expect(await transport.snapshot('sb-double', 3_600, signal())).toBe('im-double');
  expect(await transport.snapshot('sb-double', null, signal())).toBe('im-double');
  expect(
    double.calls.filter((call) => call.method === 'snapshotFilesystem').map((call) => call.args[0]),
  ).toEqual([
    { timeoutMs: 120_000, ttlMs: 3_600_000 },
    { timeoutMs: 120_000, ttlMs: null },
  ]);
  const input = {
    appName: APP,
    image: 'im-double',
    imageKind: 'snapshot' as const,
    cpu: 0.125,
    memoryMiB: 128,
    timeoutMs: 300_000,
    idleTimeoutMs: null,
    blockNetwork: true,
    outboundCidrAllowlist: null,
    env: {},
    tags: {},
  };
  await transport.create(input, signal());
  expect(double.calls.find((call) => call.method === 'images.fromId')?.args).toEqual(['im-double']);
  expect(double.calls.find((call) => call.method === 'sandboxes.create')?.args[1]).toEqual({
    imageId: 'im-double',
  });
  await transport.deleteImage('im-double', signal());
  transport.close();
  const missing = sdkDouble({ missingImage: true });
  const gone = createModalSdkTransport({ credential: (use) => use(TOKEN), load: missing.load });
  const created = await gone.create(input, signal()).catch((error: unknown) => error);
  expect(created).toBeInstanceOf(ModalNotFound);
  const deleted = await gone.deleteImage('im-double', signal()).catch((error: unknown) => error);
  expect(deleted).toBeInstanceOf(ModalNotFound);
  expect(missing.calls.some((call) => call.method === 'sandboxes.create')).toBe(false);
  gone.close();
});
