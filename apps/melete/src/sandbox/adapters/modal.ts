/**
 * Modal sandboxes behind the `SandboxProvider` seam.
 *
 * Modal runs each sandbox in gVisor. Egress is set at creation: deny-all is
 * `blockNetwork`, a CIDR allow-list is `outboundCidrAllowlist` (any protocol),
 * and everything else is refused. Modal can also change the policy of a running
 * sandbox; this adapter never asks it to. Modal's domain allow-list is not
 * offered: it is in beta, covers TLS on port 443 only, and matches on the name
 * a client presents, which Modal's own documentation says can reach other
 * destinations behind a shared endpoint.
 *
 * Every operation is a command. A process starts through a small launcher that
 * enters the working directory — exiting 112, before any marker exists, when
 * it cannot — removes the `MODAL_*` variables Modal puts in the sandbox, and
 * runs the command under `timeout -s KILL`, which kills the whole process
 * group; Modal's own exec timeout is only a backstop. Which variables to remove
 * is learnt once per sandbox, by a separate command sent before the first
 * admitted one: if that fails, the admitted command was never sent. Files are
 * listed with `find`, read with `head -c` and written with `cat`, so recursion,
 * symbolic links and byte limits are decided here rather than by an SDK helper.
 *
 * A workspace persists as a filesystem snapshot: an image of the sandbox's
 * files that a new sandbox is created from on resume, with the new lease's
 * egress, labels and lifetime. Modal keeps a filesystem snapshot for 30 days by
 * default; this adapter asks for an explicit expiry (`snapshotTtlSeconds`) so a
 * snapshot the service forgets still goes, and a snapshot that has expired or
 * been deleted is `SandboxGone`. Memory is not kept: processes do not survive.
 *
 * Modal accepts tag names like the ones in its documentation; this adapter
 * stores the `melete.*` labels with `_` for `.` and reads them back the same way.
 */
import { LABEL_SESSION, ownedLabels } from '../manifest.ts';
import { reattachByMarker } from '../marker.ts';
import {
  type ExecOutcome,
  type ExecSpec,
  type FileEntry,
  SandboxAdapterRefusal,
  type SandboxCapabilities,
  SandboxFileNotFound,
  SandboxGone,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSpec,
  SandboxStartRefused,
  SandboxTransportError,
} from '../types.ts';
import {
  type ModalFinished,
  ModalNotFound,
  type ModalRunning,
  ModalStartRefused,
  type ModalTransport,
} from './modal-transport.ts';

const MiB = 1024 * 1024;
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAIN = /^[A-Za-z0-9._-]{1,128}$/;
/** Enter the working directory or report, as the wrapper's setup failure does, that nothing ran. */
const LAUNCHER = 'cd "$1" 2>/dev/null || exit 112; shift; exec env "$@"';
const LIST = '[ -d "$1" ] || exit 3; cd "$1" && exec find . -mindepth 1 -printf "%y %s %m %P\\0"';
const READ = '[ -f "$1" ] || exit 3; exec head -c "$2" -- "$1"';
const WRITE = 'mkdir -p -- "$1" && cat > "$2" && chmod "$3" -- "$2"';
const PREPARE = 'mkdir -p -- "$1" && exec env';
const ENVIRONMENT = 'exec env';
const PROVIDER_VARIABLE = /^(MODAL_[A-Za-z0-9_]*)=/;
const NOT_FOUND_EXIT = 3;
const BACKSTOP_SECONDS = 30;
const LISTING_LIMIT = 16 * MiB;
const ENVIRONMENT_LIMIT = MiB;
/** Modal's own default for a filesystem snapshot. */
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 3600;

export function modalCapabilities(): SandboxCapabilities {
  return {
    adapter: 'modal',
    isolation: 'gvisor',
    egress: ['deny_all', 'cidr_allowlist', 'open'],
    persistence: ['none', 'snapshot'],
    maxLifetimeSeconds: 86_400,
    maxIdleSeconds: 86_400,
    streaming: false,
    reattach: 'marker_only',
    ports: 'none',
    image: 'registry',
    billing: 'per_second',
    regions: [],
    maxUploadBytes: 8 * MiB,
  };
}

export type ModalOptions = {
  transport: ModalTransport;
  /** The Modal app every sandbox is created in. */
  appName: string;
  /** Cores and MiB requested for each sandbox when the spec names none. */
  cpu?: number;
  memoryMiB?: number;
  /**
   * How long Modal keeps a workspace snapshot the service never deletes; null
   * keeps it until it is deleted. Keep it at least as long as the retention.
   */
  snapshotTtlSeconds?: number | null;
};

const tagsFor = (labels: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [key.replaceAll('.', '_'), value]),
  );

const labelsFrom = (tags: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [
      key.startsWith('melete_') ? `melete.${key.slice('melete_'.length)}` : key,
      value,
    ]),
  );

/** The names of the provider's variables in an `env` listing; a value never leaves here. */
export function providerVariables(listing: Uint8Array): string[] {
  const names = new Set<string>();
  for (const line of new TextDecoder().decode(listing).split('\n')) {
    const name = PROVIDER_VARIABLE.exec(line)?.[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type ModalSandboxProvider = SandboxProvider & { close(): void };

export function createModalProvider(options: ModalOptions): ModalSandboxProvider {
  const { transport } = options;
  if (!PLAIN.test(options.appName)) throw new Error('a Modal app name must be plain');
  const capabilities = modalCapabilities();
  const snapshotTtl =
    options.snapshotTtlSeconds === undefined ? SNAPSHOT_TTL_SECONDS : options.snapshotTtlSeconds;
  if (snapshotTtl !== null && (!Number.isSafeInteger(snapshotTtl) || snapshotTtl <= 0))
    throw new Error('a snapshot expiry is a positive whole number of seconds, or null');
  /** Per sandbox, the provider variables a command must not inherit. */
  const hidden = new Map<string, Promise<string[]>>();

  const sandboxId = (handle: SandboxHandle) => {
    if (!SANDBOX_ID.test(handle.providerSandboxId))
      throw new SandboxAdapterRefusal('not a Modal sandbox id');
    return handle.providerSandboxId;
  };

  /** Run an adapter command to the end; not an admitted command, never marker-wrapped. */
  async function run(
    handle: SandboxHandle,
    script: string,
    args: readonly string[],
    maxOutputBytes: number,
    signal: AbortSignal,
    stdin?: Uint8Array,
  ): Promise<ModalFinished> {
    const id = sandboxId(handle);
    let running: ModalRunning;
    try {
      running = await transport.start(
        id,
        {
          argv: ['/bin/sh', '-c', script, 'melete', ...args],
          timeoutSeconds: 120,
          ...(stdin ? { stdin } : {}),
        },
        signal,
      );
    } catch (error) {
      if (error instanceof SandboxAdapterRefusal) throw error;
      if (error instanceof ModalNotFound)
        throw new SandboxGone(`Modal has no such sandbox or image: ${message(error)}`);
      throw new SandboxTransportError(
        `Modal did not start the command: ${message(error)}`,
        error instanceof ModalStartRefused ? 'no' : 'unknown',
      );
    }
    try {
      return await running.finish(maxOutputBytes, signal);
    } catch (error) {
      throw new SandboxTransportError(`Modal lost the command's answer: ${message(error)}`, 'yes');
    }
  }

  const variablesFrom = (listed: ModalFinished) => {
    if (listed.exitCode !== 0 || listed.totalBytes > ENVIRONMENT_LIMIT)
      throw new SandboxTransportError(`listing the environment exited ${listed.exitCode}`);
    return providerVariables(listed.stdout);
  };

  function hiddenVariables(id: string, handle: SandboxHandle, signal: AbortSignal) {
    let pending = hidden.get(id);
    if (!pending) {
      pending = run(handle, ENVIRONMENT, [], ENVIRONMENT_LIMIT, signal).then(variablesFrom);
      hidden.set(id, pending);
      const settled = pending;
      settled.catch(() => {
        if (hidden.get(id) === settled) hidden.delete(id);
      });
    }
    return pending;
  }

  /** Create a sandbox from a registry image or a snapshot, and prepare its workspace. */
  async function launch(
    spec: SandboxSpec,
    source: { image: string; imageKind: 'registry' | 'snapshot' },
    signal: AbortSignal,
  ): Promise<SandboxHandle> {
    if (!capabilities.egress.includes(spec.egress.kind))
      throw new SandboxAdapterRefusal(`the modal adapter cannot enforce ${spec.egress.kind}`);
    if (spec.region !== null)
      throw new SandboxAdapterRefusal('Modal placement by region is not offered');
    if (spec.diskMb !== undefined)
      throw new SandboxAdapterRefusal('Modal disk size is not offered');
    if (
      !Number.isInteger(spec.lifetimeSeconds) ||
      spec.lifetimeSeconds <= 0 ||
      spec.lifetimeSeconds > capabilities.maxLifetimeSeconds
    )
      throw new SandboxAdapterRefusal('the lifetime is outside what Modal allows');
    if (spec.idleSeconds !== null && (!Number.isInteger(spec.idleSeconds) || spec.idleSeconds <= 0))
      throw new SandboxAdapterRefusal('the idle timeout is outside what Modal allows');
    for (const [key, value] of Object.entries(spec.labels))
      if (!PLAIN.test(key) || !PLAIN.test(value))
        throw new SandboxAdapterRefusal('a label is not plain enough to tag with');
    signal.throwIfAborted();
    // Not raced against the signal: a create abandoned mid-flight could still
    // leave a sandbox running that nothing knows to stop.
    let id: string;
    try {
      id = await transport.create(
        {
          appName: options.appName,
          ...source,
          cpu: spec.cpu ?? options.cpu ?? 0.125,
          memoryMiB: spec.memoryMb ?? options.memoryMiB ?? 128,
          timeoutMs: spec.lifetimeSeconds * 1000,
          idleTimeoutMs: spec.idleSeconds === null ? null : spec.idleSeconds * 1000,
          blockNetwork: spec.egress.kind === 'deny_all',
          outboundCidrAllowlist: spec.egress.kind === 'cidr_allowlist' ? spec.egress.cidrs : null,
          env: spec.env,
          tags: tagsFor(spec.labels),
        },
        signal,
      );
    } catch (error) {
      if (source.imageKind === 'snapshot' && error instanceof ModalNotFound)
        throw new SandboxGone(`the snapshot is gone at Modal: ${message(error)}`);
      throw error;
    }
    if (!SANDBOX_ID.test(id))
      throw new SandboxTransportError('Modal answered without a sandbox id');
    const handle: SandboxHandle = { providerSandboxId: id, imageDigest: null, region: null };
    try {
      signal.throwIfAborted();
      const prepared = await run(handle, PREPARE, [spec.workdir], ENVIRONMENT_LIMIT, signal);
      if (prepared.exitCode !== 0)
        throw new SandboxAdapterRefusal('the workspace could not be prepared');
      hidden.set(id, Promise.resolve(variablesFrom(prepared)));
      return handle;
    } catch (error) {
      // A sandbox this adapter will not use is not left running.
      await transport.terminate(id, AbortSignal.timeout(60_000)).catch(() => {});
      throw error;
    }
  }

  const provider: ModalSandboxProvider = {
    capabilities,

    create(spec: SandboxSpec, signal: AbortSignal): Promise<SandboxHandle> {
      return launch(spec, { image: spec.image, imageKind: 'registry' }, signal);
    },

    async snapshot(handle, signal): Promise<{ snapshotRef: string }> {
      let imageId: string;
      try {
        imageId = await transport.snapshot(sandboxId(handle), snapshotTtl, signal);
      } catch (error) {
        if (error instanceof SandboxAdapterRefusal) throw error;
        if (error instanceof ModalNotFound)
          throw new SandboxGone(`Modal has no sandbox to snapshot: ${message(error)}`);
        throw new SandboxTransportError(`Modal did not snapshot the sandbox: ${message(error)}`);
      }
      if (!SANDBOX_ID.test(imageId))
        throw new SandboxTransportError('Modal answered without a snapshot image id');
      return { snapshotRef: imageId };
    },

    resume(resumeRef, spec, signal): Promise<SandboxHandle> {
      if (!SANDBOX_ID.test(resumeRef)) throw new SandboxAdapterRefusal('not a Modal image id');
      return launch(spec, { image: resumeRef, imageKind: 'snapshot' }, signal);
    },

    async deleteSnapshot(snapshotRef, signal): Promise<void> {
      if (!SANDBOX_ID.test(snapshotRef)) throw new SandboxAdapterRefusal('not a Modal image id');
      try {
        await transport.deleteImage(snapshotRef, signal);
      } catch (error) {
        if (!(error instanceof ModalNotFound)) throw error;
      }
    },

    async connect(handle, signal): Promise<void> {
      if ((await transport.poll(sandboxId(handle), signal)) !== 'running')
        throw new SandboxAdapterRefusal('the sandbox is not running');
    },

    async exec(handle: SandboxHandle, spec: ExecSpec, signal: AbortSignal): Promise<ExecOutcome> {
      const id = sandboxId(handle);
      if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
        throw new SandboxAdapterRefusal('a command timeout must be a positive number of ms');
      if (!spec.cwd.startsWith('/'))
        throw new SandboxAdapterRefusal('a working directory must be absolute');
      let hide: string[];
      try {
        hide = await hiddenVariables(id, handle, signal);
      } catch (error) {
        if (error instanceof SandboxAdapterRefusal) throw error;
        throw new SandboxStartRefused(`the command was not sent: ${message(error)}`);
      }
      const seconds = spec.timeoutMs / 1000;
      const started = performance.now();
      let running: ModalRunning;
      try {
        running = await transport.start(
          id,
          {
            argv: [
              '/bin/sh',
              '-c',
              LAUNCHER,
              'melete-launch',
              spec.cwd,
              ...hide.flatMap((name) => ['-u', name]),
              'timeout',
              '-s',
              'KILL',
              String(seconds),
              ...spec.argv,
            ],
            timeoutSeconds: Math.ceil(seconds) + BACKSTOP_SECONDS,
            ...(spec.stdin ? { stdin: spec.stdin } : {}),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof SandboxAdapterRefusal) throw error;
        if (error instanceof ModalStartRefused)
          throw new SandboxStartRefused(`Modal refused to start the command: ${message(error)}`);
        throw new SandboxTransportError(`no start was acknowledged: ${message(error)}`, 'unknown');
      }
      let finished: ModalFinished;
      try {
        finished = await running.finish(spec.maxOutputBytes, signal);
      } catch (error) {
        throw new SandboxTransportError(`the command started, then: ${message(error)}`, 'yes');
      }
      const durationMs = Math.round(performance.now() - started);
      // `timeout -s KILL` dies with the group it kills, which Modal reports as 137.
      const timedOut = finished.exitCode === 137 && durationMs >= spec.timeoutMs - 50;
      const output = new Uint8Array(
        Math.min(spec.maxOutputBytes, finished.stdout.byteLength + finished.stderr.byteLength),
      );
      output.set(finished.stdout.subarray(0, output.byteLength));
      if (finished.stdout.byteLength < output.byteLength)
        output.set(
          finished.stderr.subarray(0, output.byteLength - finished.stdout.byteLength),
          finished.stdout.byteLength,
        );
      return {
        started: 'yes',
        state: timedOut ? 'killed' : 'exited',
        exitCode: timedOut ? null : finished.exitCode,
        signal: timedOut ? 'SIGKILL' : null,
        timedOut,
        durationMs,
        output,
        totalBytes: finished.totalBytes,
        captureLimited: finished.totalBytes > output.byteLength,
      };
    },

    reattach(handle, marker, signal) {
      return reattachByMarker(provider, handle, marker, signal);
    },

    async putFiles(handle, files, signal): Promise<void> {
      for await (const file of files) {
        if (!file.path.startsWith('/') || file.path.split('/').some((part) => part === '..'))
          throw new SandboxAdapterRefusal('an upload path must be absolute');
        if (file.bytes.byteLength > capabilities.maxUploadBytes)
          throw new SandboxAdapterRefusal('a file above the upload limit');
        const parent = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
        const mode = (file.mode & 0o111) !== 0 ? '755' : '644';
        const written = await run(
          handle,
          WRITE,
          [parent, file.path, mode],
          4096,
          signal,
          file.bytes,
        );
        if (written.exitCode !== 0)
          throw new SandboxTransportError(`an upload failed with exit ${written.exitCode}`);
      }
    },

    async listFiles(handle, root, signal): Promise<FileEntry[]> {
      const base = root.replace(/\/+$/, '') || '/';
      if (!base.startsWith('/')) throw new SandboxAdapterRefusal('a listing root must be absolute');
      const listed = await run(handle, LIST, [base], LISTING_LIMIT, signal);
      if (listed.exitCode === NOT_FOUND_EXIT)
        throw new SandboxFileNotFound(`no such directory: ${root}`);
      if (listed.exitCode !== 0)
        throw new SandboxTransportError(`listing ${root} failed with exit ${listed.exitCode}`);
      if (listed.totalBytes > LISTING_LIMIT)
        throw new SandboxAdapterRefusal('the listing is larger than the adapter reads');
      const records = new TextDecoder().decode(listed.stdout).split('\0').filter(Boolean);
      return records.map((record) => {
        const match = /^([a-z]) (\d+) ([0-7]+) (.+)$/s.exec(record);
        if (!match) throw new SandboxAdapterRefusal('the listing could not be read');
        const [, type, size, mode, relative] = match as unknown as [
          string,
          string,
          string,
          string,
          string,
        ];
        if (type !== 'f' && type !== 'd' && type !== 'l')
          throw new SandboxAdapterRefusal(
            `the listing holds an entry of type ${type}: ${relative}`,
          );
        return {
          path: relative,
          size: type === 'f' ? Number(size) : 0,
          mode: Number.parseInt(mode, 8) & 0o777,
          symlink: type === 'l',
          directory: type === 'd',
        };
      });
    },

    async getFile(handle, path, maxBytes, signal): Promise<Uint8Array> {
      const read = await run(handle, READ, [path, String(Math.max(0, maxBytes))], maxBytes, signal);
      if (read.exitCode === NOT_FOUND_EXIT) throw new SandboxFileNotFound(`no such file: ${path}`);
      if (read.exitCode !== 0)
        throw new SandboxTransportError(`reading ${path} failed with exit ${read.exitCode}`);
      return read.stdout.slice(0, maxBytes);
    },

    async destroy(handle, signal): Promise<void> {
      const id = sandboxId(handle);
      try {
        await transport.terminate(id, signal);
      } catch (error) {
        if (!(error instanceof ModalNotFound)) throw error;
      }
      hidden.delete(id);
    },

    async inspect(handle, signal): Promise<'running' | 'paused' | 'gone'> {
      const state = await transport.poll(sandboxId(handle), signal);
      return state === 'running' ? 'running' : 'gone';
    },

    async reconcile(project, live, signal): Promise<string[]> {
      if (!PLAIN.test(project)) throw new SandboxAdapterRefusal('the project label is not plain');
      const listed = await transport.list(
        options.appName,
        { melete_owner: 'v1', melete_project: project },
        signal,
      );
      const destroyed: string[] = [];
      for (const sandbox of listed) {
        const labels = labelsFrom(sandbox.tags);
        // The server's tag filter is a convenience; ownership is decided here.
        if (!SANDBOX_ID.test(sandbox.sandboxId) || !ownedLabels(labels, project)) continue;
        const session = labels[LABEL_SESSION];
        if (live.has(sandbox.sandboxId) || (session !== undefined && live.has(session))) continue;
        try {
          await transport.terminate(sandbox.sandboxId, signal);
        } catch (error) {
          if (!(error instanceof ModalNotFound)) throw error;
        }
        hidden.delete(sandbox.sandboxId);
        destroyed.push(sandbox.sandboxId);
      }
      return destroyed;
    },

    close() {
      transport.close();
    },
  };
  return provider;
}
