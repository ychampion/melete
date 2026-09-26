import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type JsonObject, jsonObject } from '@melete/contracts';
import { ConnectorFaultError } from './faults.ts';
import { bearerChallenge } from './mcp-oauth.ts';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const TEMP_PREFIX = 'melete-mcp-';

export type McpEndpoint =
  | { transport: 'stdio'; command: string; args: string[] }
  | { transport: 'http'; url: string };

export interface McpTransport {
  request(method: string, params?: JsonObject, signal?: AbortSignal): Promise<unknown>;
  notify(method: string): Promise<void>;
  close(): Promise<void>;
}

export type McpTransportOptions = {
  timeoutMs?: number;
  maxMessageBytes?: number;
  /** Only the trusted credential store supplies this value. */
  accessToken?: () => Promise<string | undefined>;
  /**
   * How an HTTP request is made. The service supplies a public-only, pinned
   * fetch for an endpoint that may not reach private addresses.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Told the scopes a server asked for when it refused a call for want of them. */
  onInsufficientScope?: (scope: string) => Promise<void>;
};

const disconnected = () =>
  new ConnectorFaultError({
    kind: 'transient_before_dispatch',
    detail: 'MCP transport is unavailable before dispatch',
  });

type RpcMessage = JsonObject & { jsonrpc: '2.0' };

function parseMessage(text: string): RpcMessage {
  const value = jsonObject.parse(JSON.parse(text));
  if (value.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC version');
  return value as RpcMessage;
}

function resultOf(message: RpcMessage): unknown {
  if ('error' in message) throw new Error('MCP server rejected the request');
  if (!('result' in message)) throw new Error('Invalid MCP response');
  return message.result;
}

const unsupported = (id: string | number): JsonObject => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32601,
    message: 'Melete does not expose client-side capabilities to MCP servers',
  },
});

/**
 * Inherited process credentials and language startup hooks never reach the
 * worker. This is environment hygiene, not a filesystem or network sandbox.
 */
export function filteredMcpEnvironment(
  source: NodeJS.ProcessEnv,
  workerDirectory: string,
): NodeJS.ProcessEnv {
  const permitted = new Set(['path', 'systemroot', 'windir', 'pathext', 'lang', 'lc_all', 'tz']);
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (permitted.has(name.toLowerCase()) && value !== undefined) filtered[name] = value;
  }
  for (const name of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_CONFIG_HOME',
    'TMP',
    'TEMP',
  ]) {
    filtered[name] = workerDirectory;
  }
  return filtered;
}

async function removeWorkerDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const parent = await realpath(tmpdir());
  if (
    dirname(absolute) !== parent ||
    !basename(absolute).startsWith(TEMP_PREFIX) ||
    (await lstat(absolute)).isSymbolicLink() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error('Refusing to remove an unverified MCP worker directory');
  }
  await rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/**
 * A server's standard input and output, wherever the server runs. The
 * transport writes newline-delimited JSON-RPC to it and reads the same back;
 * the channel's owner decides how the server is started and stopped.
 */
export interface StdioChannel {
  write(text: string): void;
  onData(listener: (text: string) => void): void;
  /** The server ended or the stream broke. Called at most once. */
  onClose(listener: () => void): void;
  /** Stop the server; settles once it is gone. */
  close(): Promise<void>;
}

/** Newline-delimited JSON-RPC over a channel, refusing every client-side capability. */
export function openLineMcpTransport(
  channel: StdioChannel,
  options: McpTransportOptions = {},
): McpTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  let closed = false;
  let failure: Error | undefined;
  let stopping: Promise<void> | undefined;
  let counter = 0;
  let buffer = '';
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const stop = () => {
    stopping ??= channel.close().catch(() => {});
    return stopping;
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    void stop();
  };
  channel.onClose(() => fail(new Error('MCP worker exited')));
  channel.onData((chunk) => {
    if (failure) return;
    try {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > maxBytes) throw new Error('MCP message limit exceeded');
        const message = parseMessage(line);
        if (typeof message.method === 'string') {
          if (typeof message.id === 'number' || typeof message.id === 'string') {
            channel.write(`${JSON.stringify(unsupported(message.id))}\n`);
          }
          // Notifications cannot mutate a pinned catalog or grant new capabilities.
          continue;
        }
        if (typeof message.id !== 'number') throw new Error('Invalid MCP response id');
        const item = pending.get(message.id);
        if (!item) throw new Error('Unexpected MCP response id');
        pending.delete(message.id);
        try {
          item.resolve(resultOf(message));
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error('Invalid MCP response'));
        }
      }
      if (Buffer.byteLength(buffer) > maxBytes) throw new Error('MCP message limit exceeded');
    } catch {
      fail(new Error('MCP worker emitted an invalid or oversized message'));
    }
  });
  return {
    request(method, params, signal) {
      if (closed || failure) return Promise.reject(disconnected());
      if (signal?.aborted) return Promise.reject(new Error('MCP request cancelled'));
      if (pending.size >= 16) return Promise.reject(new Error('MCP request concurrency exceeded'));
      const id = ++counter;
      const serialized = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params ? { params } : {}),
      });
      if (Buffer.byteLength(serialized) > maxBytes) {
        return Promise.reject(new Error('MCP request limit exceeded'));
      }
      return new Promise((resolveRequest, rejectRequest) => {
        const aborted = () => fail(new Error('MCP request cancelled; outcome may be unknown'));
        const timer = setTimeout(() => fail(new Error('MCP request timed out')), timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
        };
        pending.set(id, {
          resolve(value) {
            cleanup();
            resolveRequest(value);
          },
          reject(error) {
            cleanup();
            rejectRequest(error);
          },
        });
        signal?.addEventListener('abort', aborted, { once: true });
        channel.write(`${serialized}\n`);
      });
    },
    async notify(method) {
      if (closed || failure) throw failure ?? new Error('MCP transport closed');
      channel.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    async close() {
      if (closed) return;
      closed = true;
      fail(new Error('MCP transport closed'));
      await stop();
    },
  };
}

/** Local subprocess seam; production must additionally supply OS-level worker isolation. */
export async function openStdioMcpTransport(
  endpoint: Extract<McpEndpoint, { transport: 'stdio' }>,
  options: McpTransportOptions = {},
): Promise<McpTransport> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('MCP stdio requires an isolated OS launcher; only test fixtures may spawn');
  }
  const token = await options.accessToken?.();
  const directory = await mkdtemp(join(await realpath(tmpdir()), TEMP_PREFIX));
  const child = spawn(endpoint.command, endpoint.args, {
    cwd: directory,
    env: {
      ...filteredMcpEnvironment(process.env, directory),
      ...(token ? { MELETE_MCP_ACCESS_TOKEN: token } : {}),
    },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let ended: (() => void) | undefined;
  const end = () => {
    const listener = ended;
    ended = undefined;
    listener?.();
  };
  const exited = new Promise<void>((done) =>
    child.once('close', () => {
      clearTimeout(killTimer);
      done();
    }),
  );
  child.on('error', end);
  child.on('exit', end);
  child.stdin.on('error', end);
  child.stdout.setEncoding('utf8');
  return openLineMcpTransport(
    {
      write: (text) => {
        child.stdin.write(text);
      },
      onData: (listener) => {
        child.stdout.on('data', listener);
      },
      onClose: (listener) => {
        ended = listener;
      },
      async close() {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill();
          // A server cannot hold service shutdown open by ignoring termination.
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
        }
        await exited;
        await removeWorkerDirectory(directory);
      },
    },
    options,
  );
}

/** HTTP transport uses only the configured endpoint; redirects and client capabilities are refused. */
export function openHttpMcpTransport(
  endpoint: Extract<McpEndpoint, { transport: 'http' }>,
  options: McpTransportOptions = {},
): McpTransport {
  const maxBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  let session: string | undefined;
  let counter = 0;
  let closed = false;
  const controllers = new Set<AbortController>();

  async function post(message: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (closed) throw disconnected();
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 10_000);
    let reader: { cancel(): Promise<void> } | undefined;
    try {
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > maxBytes) throw new Error('MCP request limit exceeded');
      const token = await options.accessToken?.();
      const response = await (options.fetch ?? fetch)(endpoint.url, {
        method: 'POST',
        redirect: 'error',
        // The pinned Windows Bun pool can stall MCP posts while Hermes streams.
        // A dedicated HTTP connection preserves the MCP session header without
        // turning an unsent pooled request into an uncertain broker action.
        keepalive: false,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          ...(session ? { 'MCP-Session-Id': session } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // MCP session termination and HTTP authentication reject before tool execution.
        if (response.status === 404 && session) throw disconnected();
        if (response.status === 403) {
          const challenge = bearerChallenge(response.headers.get('www-authenticate'));
          if (challenge?.error === 'insufficient_scope') {
            await options.onInsufficientScope?.(challenge.scope ?? '').catch(() => {});
            // The person signs in again with more access; nobody is substituted.
            throw new ConnectorFaultError({
              kind: 'revoked_credential',
              detail: 'MCP server needs more access than was granted',
            });
          }
        }
        if (response.status === 401 || response.status === 403)
          throw new ConnectorFaultError({
            kind: response.status === 401 ? 'expired_credential' : 'revoked_credential',
            detail:
              response.status === 401 ? 'MCP credential expired' : 'MCP credential was revoked',
          });
        throw new Error(`MCP HTTP status ${response.status}`);
      }
      if (!('id' in message) || !('method' in message)) {
        if (response.status !== 202) throw new Error('MCP notification was not acknowledged');
        return undefined;
      }
      const receivedSession = response.headers.get('mcp-session-id');
      if (message.method === 'initialize' && receivedSession !== null) {
        if (!/^[\x21-\x7e]{1,256}$/.test(receivedSession))
          throw new Error('Invalid MCP session id');
        session = receivedSession;
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType !== 'application/json' && contentType !== 'text/event-stream') {
        throw new Error('Unsupported MCP response content type');
      }
      if (!response.body) throw new Error('Empty MCP response');
      const bodyReader = response.body.getReader();
      reader = bodyReader;
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      for (;;) {
        const chunk = await bodyReader.read();
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes > maxBytes) throw new Error('MCP response limit exceeded');
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (contentType === 'application/json' && chunk.done) {
          const reply = parseMessage(buffer);
          if (reply.id !== message.id) throw new Error('MCP response id mismatch');
          return resultOf(reply);
        }
        if (contentType === 'text/event-stream') {
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(buffer);
            if (!boundary || boundary.index === undefined) break;
            const event = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''))
              .join('\n');
            if (!data) continue;
            const reply = parseMessage(data);
            if (typeof reply.method === 'string') {
              if (typeof reply.id === 'string' || typeof reply.id === 'number') {
                await post(unsupported(reply.id), controller.signal);
              }
            } else if (reply.id === message.id) return resultOf(reply);
            else throw new Error('MCP response id mismatch');
          }
        }
        if (chunk.done) throw new Error('MCP stream ended without an acknowledgement');
      }
    } catch (error) {
      // These network codes prove no destination connection existed. Resets and
      // timeouts do not prove that, so they retain the unknown outcome.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(error.code))
      )
        throw disconnected();
      throw error;
    } finally {
      await reader?.cancel().catch(() => {});
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controllers.delete(controller);
    }
  }

  return {
    request: (method, params, signal) =>
      post({ jsonrpc: '2.0', id: ++counter, method, ...(params ? { params } : {}) }, signal),
    async notify(method) {
      await post({ jsonrpc: '2.0', method });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      if (session) {
        // Session disposal has no tool effect and is never used to replay a call.
        const token = await options.accessToken?.().catch(() => undefined);
        // The same fetch every request used, so closing is held to the same
        // address checks as talking was.
        const response = await (options.fetch ?? fetch)(endpoint.url, {
          method: 'DELETE',
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 10_000, 2_000)),
          headers: {
            'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
            'MCP-Session-Id': session,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        }).catch(() => undefined);
        await response?.body?.cancel().catch(() => {});
      }
      // No session restart or request replay is safe evidence of an external effect.
    },
  };
}
