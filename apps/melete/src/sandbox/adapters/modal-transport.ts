/**
 * The narrow boundary between the Modal adapter and Modal itself.
 *
 * Modal's API is gRPC, reached through its SDK, so it cannot be recorded and
 * replayed at the HTTP layer the way E2B's is. This interface is the seam
 * instead: the adapter speaks only these calls, the SDK-backed transport turns
 * them into Modal requests, and an authored stand-in answers them in tests.
 * Evidence gathered through the stand-in is weaker than an HTTP replay: it
 * checks what the adapter asks for and how it reads the answers, not the wire
 * format Modal accepts. The live test is what proves the latter.
 */

export type ModalToken = { tokenId: string; tokenSecret: string };

/** Lends the token for as long as `use` runs. */
export type ModalCredential = <T>(use: (token: ModalToken) => Promise<T>) => Promise<T>;

export type ModalCreate = {
  appName: string;
  /** A registry image reference, such as `debian:bookworm-slim`, or a snapshot's image id. */
  image: string;
  imageKind: 'registry' | 'snapshot';
  cpu: number;
  memoryMiB: number;
  timeoutMs: number;
  idleTimeoutMs: number | null;
  blockNetwork: boolean;
  outboundCidrAllowlist: readonly string[] | null;
  env: Readonly<Record<string, string>>;
  tags: Readonly<Record<string, string>>;
};

export type ModalExec = {
  argv: readonly string[];
  /** Modal's own limit on the process, a backstop behind the adapter's. */
  timeoutSeconds: number;
  stdin?: Uint8Array;
};

export type ModalFinished = {
  /** The exit status, with a signal reported as 128 plus its number. */
  exitCode: number;
  /** Each at most the requested bytes. */
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Everything the process wrote, kept or not. */
  totalBytes: number;
};

export interface ModalRunning {
  /** Waits for the process to end and reads its output. */
  finish(maxOutputBytes: number, signal: AbortSignal): Promise<ModalFinished>;
}

export interface ModalTransport {
  create(input: ModalCreate, signal: AbortSignal): Promise<string>;
  /** Resolves once Modal has accepted the start; from then on the process exists. */
  start(sandboxId: string, exec: ModalExec, signal: AbortSignal): Promise<ModalRunning>;
  terminate(sandboxId: string, signal: AbortSignal): Promise<void>;
  poll(sandboxId: string, signal: AbortSignal): Promise<'running' | 'finished' | 'gone'>;
  /**
   * Snapshot a sandbox's filesystem to an image that expires after
   * `ttlSeconds`, or never when null. Returns the image id.
   */
  snapshot(sandboxId: string, ttlSeconds: number | null, signal: AbortSignal): Promise<string>;
  /** Throws `ModalNotFound` when the image is already gone. */
  deleteImage(imageId: string, signal: AbortSignal): Promise<void>;
  /** Whether Modal still has the image: false only on Modal's own not-found answer. */
  imageExists(imageId: string, signal: AbortSignal): Promise<boolean>;
  /** Running sandboxes in the app that carry at least these tags, with all of their tags. */
  list(
    appName: string,
    tags: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<{ sandboxId: string; tags: Record<string, string> }[]>;
  close(): void;
}

/** Modal answered that the process was not created. */
export class ModalStartRefused extends Error {
  override readonly name = 'ModalStartRefused';
}

/** Modal did not answer, or answered in a way that settles nothing. */
export class ModalUnavailable extends Error {
  override readonly name = 'ModalUnavailable';
}

export class ModalNotFound extends Error {
  override readonly name = 'ModalNotFound';
}

/** The text that only a marker-wrapped command's script contains. */
const MARKED = 'mkdir -p /var/tmp/.melete-exec';
/** How long after a marked command starts its acknowledgement is cut. */
export const MODAL_AFTER_START_CUT_MS = 1_000;

/**
 * Wrap a transport so the next marked command loses its answer: before the
 * start is acknowledged, or once the command has started and before it ends.
 */
export function modalAcknowledgementControl(inner: ModalTransport) {
  let pending: 'before_start' | 'after_start' | null = null;
  const transport: ModalTransport = {
    create: (input, signal) => inner.create(input, signal),
    terminate: (sandboxId, signal) => inner.terminate(sandboxId, signal),
    poll: (sandboxId, signal) => inner.poll(sandboxId, signal),
    snapshot: (sandboxId, ttl, signal) => inner.snapshot(sandboxId, ttl, signal),
    deleteImage: (imageId, signal) => inner.deleteImage(imageId, signal),
    imageExists: (imageId, signal) => inner.imageExists(imageId, signal),
    list: (appName, tags, signal) => inner.list(appName, tags, signal),
    close: () => inner.close(),
    async start(sandboxId, exec, signal) {
      const loss = pending && exec.argv.some((word) => word.includes(MARKED)) ? pending : null;
      if (loss) pending = null;
      if (loss === 'before_start')
        throw new ModalUnavailable('the connection closed before the start was acknowledged');
      const running = await inner.start(sandboxId, exec, signal);
      if (loss !== 'after_start') return running;
      return {
        async finish(maxOutputBytes, finishSignal) {
          // The process goes on; only its answer is lost.
          void running.finish(maxOutputBytes, finishSignal).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, MODAL_AFTER_START_CUT_MS));
          throw new ModalUnavailable('the connection dropped after the command started');
        },
      };
    },
  };
  return {
    transport,
    lose(when: 'before_start' | 'after_start') {
      pending = when;
    },
  };
}
