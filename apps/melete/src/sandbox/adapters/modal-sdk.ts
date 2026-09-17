/**
 * The Modal transport over Modal's JavaScript SDK.
 *
 * Modal's API is gRPC, so the SDK is used rather than a hand-written client:
 * it carries the protocol definitions, authentication and the command router
 * that runs processes inside a sandbox.
 *
 * The SDK resolves a profile from `~/.modal.toml`, which it reads when it is
 * first imported, and from `MODAL_*` environment variables. This transport
 * reads neither. The SDK is imported only when a client is first needed; the
 * token is borrowed from the caller's callback and handed to the client
 * explicitly, and the client keeps it until `close()`. Before any request, the
 * resolved profile is compared with what this transport supplied, and a client
 * that took its server address, environment, sandbox backend, image builder
 * version, throttle or connection settings, or OAuth settings from anywhere
 * else is refused: a redirected server would otherwise receive the token.
 *
 * A workspace snapshot is `Sandbox.snapshotFilesystem`, which returns an image
 * whose expiry is given explicitly; resuming creates a sandbox from
 * `images.fromId`, and forgetting is `images.delete`. An image Modal no longer
 * has is `ModalNotFound` from each of them.
 *
 * The SDK retries a process start on transient errors under one exec id, so a
 * start that fails once its request has left cannot rule out an earlier
 * attempt having started the process. Only what fails before a request is sent
 * counts as a refusal here.
 */
import type { ContainerProcess, ModalClient, ModalClientParams, Profile, Sandbox } from 'modal';
import { SandboxAdapterRefusal } from '../types.ts';
import {
  type ModalCreate,
  type ModalCredential,
  type ModalExec,
  type ModalFinished,
  ModalNotFound,
  type ModalRunning,
  ModalStartRefused,
  type ModalToken,
  type ModalTransport,
  ModalUnavailable,
} from './modal-transport.ts';

export const MODAL_SERVER = 'https://api.modal.com:443';
/** The SDK's own default, which only its environment variable changes. */
const CHANNEL_IDLE_MS = 30_000;
const THROTTLE_WAIT_SECONDS = 60;
/** The SDK refuses a command line of 2^16 bytes or more before sending it. */
const ARGV_LIMIT = 60_000;
const GRPC_NOT_FOUND = 5;
const TOKEN_SHAPE = /\b(?:ak|as)-[A-Za-z0-9]{8,}\b/g;
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

type ModalModule = {
  ModalClient: new (params: ModalClientParams) => ModalClient;
};

export type ModalSdkOptions = {
  credential: ModalCredential;
  /** A Modal environment name; absent means the workspace's default. */
  environment?: string;
  /** Where the SDK comes from; replaced only in tests. */
  load?: () => Promise<ModalModule>;
};

type ProfileFields = Pick<
  Profile,
  | 'serverUrl'
  | 'tokenId'
  | 'tokenSecret'
  | 'oauthRefreshToken'
  | 'oauthClientId'
  | 'oauthClientSecret'
  | 'oauthJwtKey'
  | 'environment'
  | 'imageBuilderVersion'
  | 'maxThrottleWaitSecs'
  | 'sandboxChannelIdleTimeoutMs'
  | 'sandboxV2'
>;

/**
 * What in a resolved profile differs from what this transport supplied, named
 * but never shown; null when nothing does.
 */
export function profileMismatch(
  profile: ProfileFields,
  token: ModalToken,
  environment: string | undefined,
): string | null {
  if (profile.serverUrl !== MODAL_SERVER) return 'the server address';
  if (profile.tokenId !== token.tokenId || profile.tokenSecret !== token.tokenSecret)
    return 'the token';
  if (
    profile.oauthRefreshToken ||
    profile.oauthClientId ||
    profile.oauthClientSecret ||
    profile.oauthJwtKey
  )
    return 'OAuth settings';
  if ((profile.environment || undefined) !== environment) return 'the environment';
  if (profile.imageBuilderVersion) return 'the image builder version';
  if (profile.sandboxV2) return 'the sandbox backend';
  if (profile.maxThrottleWaitSecs !== THROTTLE_WAIT_SECONDS) return 'the throttle wait';
  if (profile.sandboxChannelIdleTimeoutMs !== CHANNEL_IDLE_MS) return 'the connection idle timeout';
  return null;
}

/** An error's text with the token, and anything shaped like a Modal token, removed. */
export function scrubModalError(error: unknown, secrets: readonly string[]): string {
  let text =
    error instanceof Error
      ? `${error.name}: ${error.message}${'details' in error && error.details ? ` ${String(error.details)}` : ''}`
      : String(error);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(TOKEN_SHAPE, '[redacted]').slice(0, 2_000);
}

const notFound = (error: unknown) =>
  error instanceof Error &&
  (error.name === 'NotFoundError' ||
    (error.name === 'ClientError' && (error as { code?: unknown }).code === GRPC_NOT_FOUND));

function aborted(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error('the request was abandoned'));
    signal.addEventListener('abort', () => reject(new Error('the request was abandoned')), {
      once: true,
    });
  });
}

/** Everything a stream yields: at most `max` bytes kept, every byte counted. */
async function drain(stream: ReadableStream<Uint8Array>, max: number) {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (size < max) {
        const slice = value.subarray(0, max - size);
        kept.push(slice);
        size += slice.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of kept) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, total };
}

/**
 * A client holding the caller's token, refused before it sends anything if its
 * profile came from anywhere but here.
 */
export async function openModalClient(
  options: ModalSdkOptions,
): Promise<{ client: ModalClient; secrets: string[] }> {
  const { ModalClient: Client } = await (options.load ?? (() => import('modal')))();
  return options.credential(async (token) => {
    if (!token.tokenId || !token.tokenSecret)
      throw new SandboxAdapterRefusal('the Modal token is incomplete');
    const client = new Client({
      tokenId: token.tokenId,
      tokenSecret: token.tokenSecret,
      ...(options.environment ? { environment: options.environment } : {}),
      maxThrottleWaitSecs: THROTTLE_WAIT_SECONDS,
      logger: SILENT,
      logLevel: 'error',
    });
    const mismatch = profileMismatch(client.profile, token, options.environment);
    if (mismatch) {
      client.close();
      throw new SandboxAdapterRefusal(
        `the Modal client took ${mismatch} from outside this adapter; the token was not sent`,
      );
    }
    return { client, secrets: [token.tokenId, token.tokenSecret] };
  });
}

export function createModalSdkTransport(options: ModalSdkOptions): ModalTransport {
  let pending: Promise<ModalClient> | null = null;
  let secrets: string[] = [];
  let closed = false;
  const sandboxes = new Map<string, Sandbox>();
  const scrub = (error: unknown) => scrubModalError(error, secrets);

  async function open(): Promise<ModalClient> {
    const opened = await openModalClient(options);
    secrets = opened.secrets;
    return opened.client;
  }

  function client(): Promise<ModalClient> {
    if (closed) return Promise.reject(new SandboxAdapterRefusal('the Modal transport is closed'));
    if (!pending) {
      const opening = open();
      pending = opening;
      opening.catch(() => {
        if (pending === opening) pending = null;
      });
    }
    return pending;
  }

  async function sandbox(id: string): Promise<Sandbox> {
    const modal = await client();
    const known = sandboxes.get(id);
    if (known) return known;
    const found = await modal.sandboxes.fromId(id);
    sandboxes.set(id, found);
    return found;
  }

  const forget = (id: string) => {
    sandboxes.get(id)?.detach();
    sandboxes.delete(id);
  };

  const environment = options.environment ? { environment: options.environment } : {};

  return {
    async create(input: ModalCreate): Promise<string> {
      const modal = await client();
      try {
        const app = await modal.apps.fromName(input.appName, {
          createIfMissing: true,
          ...environment,
        });
        const image =
          input.imageKind === 'snapshot'
            ? await modal.images.fromId(input.image)
            : modal.images.fromRegistry(input.image);
        const created = await modal.sandboxes.create(app, image, {
          cpu: input.cpu,
          memoryMiB: input.memoryMiB,
          timeoutMs: input.timeoutMs,
          ...(input.idleTimeoutMs === null ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
          blockNetwork: input.blockNetwork,
          ...(input.outboundCidrAllowlist
            ? { outboundCidrAllowlist: [...input.outboundCidrAllowlist] }
            : {}),
          ...(Object.keys(input.env).length ? { env: { ...input.env } } : {}),
          tags: { ...input.tags },
          includeOidcIdentityToken: false,
        });
        sandboxes.set(created.sandboxId, created);
        return created.sandboxId;
      } catch (error) {
        if (notFound(error)) throw new ModalNotFound(scrub(error));
        throw new ModalUnavailable(scrub(error));
      }
    },

    async snapshot(sandboxId: string, ttlSeconds: number | null): Promise<string> {
      const target = await sandbox(sandboxId);
      try {
        const image = await target.snapshotFilesystem({
          timeoutMs: 120_000,
          ttlMs: ttlSeconds === null ? null : ttlSeconds * 1000,
        });
        return image.imageId;
      } catch (error) {
        if (notFound(error)) throw new ModalNotFound(scrub(error));
        throw new ModalUnavailable(scrub(error));
      }
    },

    async deleteImage(imageId: string): Promise<void> {
      const modal = await client();
      try {
        await modal.images.delete(imageId);
      } catch (error) {
        if (notFound(error)) throw new ModalNotFound(scrub(error));
        throw new ModalUnavailable(scrub(error));
      }
    },

    async start(sandboxId: string, exec: ModalExec): Promise<ModalRunning> {
      if (exec.argv.reduce((bytes, word) => bytes + Buffer.byteLength(word), 0) > ARGV_LIMIT)
        throw new ModalStartRefused('the command line is longer than Modal accepts');
      if (!Number.isInteger(exec.timeoutSeconds) || exec.timeoutSeconds <= 0)
        throw new ModalStartRefused('a Modal exec timeout is a positive number of seconds');
      let target: Sandbox;
      try {
        target = await sandbox(sandboxId);
      } catch (error) {
        if (error instanceof SandboxAdapterRefusal) throw error;
        throw new ModalStartRefused(scrub(error));
      }
      let process: ContainerProcess<Uint8Array>;
      try {
        process = await target.exec([...exec.argv], {
          mode: 'binary',
          stdout: 'pipe',
          stderr: 'pipe',
          timeoutMs: exec.timeoutSeconds * 1000,
        });
      } catch (error) {
        // Neither is a refusal: the start may have left before the error came back.
        if (notFound(error)) throw new ModalNotFound(scrub(error));
        throw new ModalUnavailable(scrub(error));
      }
      return {
        async finish(maxOutputBytes: number, signal: AbortSignal): Promise<ModalFinished> {
          const work = (async () => {
            const input = (async () => {
              const writer = process.stdin.getWriter();
              if (exec.stdin?.byteLength) await writer.write(exec.stdin);
              await writer.close();
            })();
            const [stdout, stderr] = await Promise.all([
              drain(process.stdout, maxOutputBytes),
              drain(process.stderr, maxOutputBytes),
              input,
            ]);
            const exitCode = await process.wait();
            return {
              exitCode,
              stdout: stdout.bytes,
              stderr: stderr.bytes,
              totalBytes: stdout.total + stderr.total,
            };
          })();
          try {
            return await Promise.race([work, aborted(signal)]);
          } catch (error) {
            work.catch(() => {});
            throw new ModalUnavailable(scrub(error));
          }
        },
      };
    },

    async terminate(sandboxId: string): Promise<void> {
      const target = await sandbox(sandboxId);
      try {
        await target.terminate();
      } catch (error) {
        if (notFound(error)) throw new ModalNotFound(scrub(error));
        throw new ModalUnavailable(scrub(error));
      } finally {
        forget(sandboxId);
      }
    },

    async poll(sandboxId: string) {
      const target = await sandbox(sandboxId);
      try {
        return (await target.poll()) === null ? 'running' : 'finished';
      } catch (error) {
        if (notFound(error)) return 'gone';
        throw new ModalUnavailable(scrub(error));
      }
    },

    async list(appName: string, tags: Readonly<Record<string, string>>) {
      const modal = await client();
      try {
        let appId: string;
        try {
          appId = (await modal.apps.fromName(appName, { createIfMissing: false, ...environment }))
            .appId;
        } catch (error) {
          if (notFound(error)) return [];
          throw error;
        }
        const found: { sandboxId: string; tags: Record<string, string> }[] = [];
        for await (const listed of modal.sandboxes.list({
          appId,
          tags: { ...tags },
          ...environment,
        })) {
          try {
            found.push({ sandboxId: listed.sandboxId, tags: await listed.getTags() });
          } catch (error) {
            // One that finished between the listing and the lookup is not an orphan.
            if (!notFound(error)) throw error;
          } finally {
            listed.detach();
          }
        }
        return found;
      } catch (error) {
        throw new ModalUnavailable(scrub(error));
      }
    },

    close() {
      closed = true;
      for (const id of [...sandboxes.keys()]) forget(id);
      const opened = pending;
      pending = null;
      void opened?.then((modal) => modal.close()).catch(() => {});
    },
  };
}
