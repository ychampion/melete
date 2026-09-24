/**
 * An authored stand-in for Modal at the transport seam, for tests only.
 *
 * It answers the calls the Modal adapter makes with the facts Modal documents
 * — `blockNetwork` drops all egress, a CIDR allow-list admits those ranges, a
 * sandbox lives for its timeout, a signal is reported as 128 plus its number —
 * and runs commands on the in-memory fake engine.
 *
 * This is weaker evidence than an HTTP replay. Nothing here was recorded from
 * Modal, and the calls are the adapter's own vocabulary rather than Modal's
 * wire format: it shows the adapter asks for the right things and reads the
 * answers correctly, and nothing about how Modal's servers behave. The live
 * test is the evidence for that. One simplification is named: stdout and
 * stderr arrive together on stdout.
 *
 * Filesystem snapshots are images: taking one leaves the sandbox running, a
 * sandbox created from one starts with a copy of its files, and creating from
 * a deleted one is `ModalNotFound`, which Modal's documentation says is what
 * an expired or deleted snapshot raises.
 */
import { FakeSandboxEngine } from '../fake.ts';
import type { EgressPolicy } from '../types.ts';
import {
  type ModalCreate,
  type ModalExec,
  type ModalFinished,
  ModalNotFound,
  type ModalRunning,
  ModalStartRefused,
  type ModalTransport,
  ModalUnavailable,
} from './modal-transport.ts';

export const MODAL_STANDIN_EVIDENCE =
  'authored stand-in at the Modal transport seam; weaker than an HTTP replay';

export function createModalStandin(
  options: {
    /** Variables the stand-in puts in every sandbox, as a provider may. */
    injected?: Readonly<Record<string, string>>;
  } = {},
) {
  const engine = new FakeSandboxEngine();
  /** Each snapshot image's requested expiry, in seconds; null for none. */
  const expiries = new Map<string, number | null>();
  let failSnapshot = false;
  const transport: ModalTransport = {
    async create(input: ModalCreate, signal: AbortSignal) {
      signal.throwIfAborted();
      if (input.cpu <= 0 || input.memoryMiB < 128) throw new Error('invalid resources');
      if (input.blockNetwork && input.outboundCidrAllowlist)
        throw new Error('outboundCidrAllowlist cannot be used when blockNetwork is enabled');
      const egress: EgressPolicy = input.blockNetwork
        ? { kind: 'deny_all' }
        : input.outboundCidrAllowlist
          ? { kind: 'cidr_allowlist', cidrs: [...input.outboundCidrAllowlist] }
          : { kind: 'open' };
      const saved = input.imageKind === 'snapshot' ? engine.snapshots.get(input.image) : null;
      if (input.imageKind === 'snapshot' && !saved)
        throw new ModalNotFound(`Could not find image with ID ${input.image}`);
      const sandbox = engine.create({
        image: input.image,
        egress,
        labels: { ...input.tags },
        env: { ...options.injected, ...input.env },
        lifetimeSeconds: input.timeoutMs / 1000,
      });
      if (saved) sandbox.fs = saved.clone();
      return sandbox.id;
    },

    async snapshot(sandboxId: string, ttlSeconds: number | null, signal: AbortSignal) {
      signal.throwIfAborted();
      const sandbox = engine.get(sandboxId);
      if (!sandbox) throw new ModalNotFound(`Sandbox ${sandboxId} not found`);
      if (failSnapshot) {
        failSnapshot = false;
        throw new ModalUnavailable('UNAVAILABLE: the snapshot did not complete');
      }
      const imageId = engine.snapshot(sandbox);
      expiries.set(imageId, ttlSeconds);
      return imageId;
    },

    async imageExists(imageId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      return engine.snapshots.has(imageId);
    },

    async deleteImage(imageId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!engine.snapshots.delete(imageId))
        throw new ModalNotFound(`Could not find image with ID ${imageId}`);
    },

    async start(sandboxId: string, exec: ModalExec, signal: AbortSignal): Promise<ModalRunning> {
      signal.throwIfAborted();
      const sandbox = engine.get(sandboxId);
      if (!sandbox) throw new ModalStartRefused(`Sandbox ${sandboxId} has already completed`);
      const chunks: Uint8Array[] = [];
      let total = 0;
      const child = engine.spawn(sandbox, exec.argv, {
        cwd: '/',
        stdin: exec.stdin ?? new Uint8Array(0),
        onOutput: (bytes) => {
          chunks.push(bytes);
          total += bytes.byteLength;
        },
      });
      const backstop = setTimeout(() => child.kill(), exec.timeoutSeconds * 1000);
      void child.done.then(() => clearTimeout(backstop));
      return {
        async finish(maxOutputBytes: number): Promise<ModalFinished> {
          const result = await child.done;
          const stdout = new Uint8Array(Math.min(maxOutputBytes, total));
          let offset = 0;
          for (const chunk of chunks) {
            if (offset >= stdout.byteLength) break;
            const slice = chunk.subarray(0, stdout.byteLength - offset);
            stdout.set(slice, offset);
            offset += slice.byteLength;
          }
          return {
            exitCode: result.killed ? 137 : (result.exitCode ?? 0),
            stdout,
            stderr: new Uint8Array(0),
            totalBytes: total,
          };
        },
      };
    },

    async terminate(sandboxId: string) {
      engine.destroy(sandboxId);
    },

    async poll(sandboxId: string) {
      return engine.get(sandboxId) ? 'running' : 'gone';
    },

    async list(_appName: string, tags: Readonly<Record<string, string>>) {
      return [...engine.sandboxes.values()]
        .filter((sandbox) =>
          Object.entries(tags).every(([key, value]) => sandbox.labels[key] === value),
        )
        .map((sandbox) => ({ sandboxId: sandbox.id, tags: { ...sandbox.labels } }));
    },

    close() {},
  };
  return {
    transport,
    engine,
    expiries,
    /** The next snapshot fails, and the sandbox keeps running. */
    failNextSnapshot() {
      failSnapshot = true;
    },
  };
}
