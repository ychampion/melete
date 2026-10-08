import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type JsonObject, jsonObject } from '@melete/contracts';
import { ConnectorFaultError } from './faults.ts';
import { mcpHeaderValue } from './mcp-headers.ts';
import { bearerChallenge } from './mcp-oauth.ts';

/** The handshake revision `initialize` asks for; a server may answer with an earlier one. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
/** The stateless revision: no handshake, no session, the version on every request. */
export const MCP_STATELESS_VERSION = '2026-07-28';
/** Handshake revisions a server may settle on, newest first. */
export const MCP_HANDSHAKE_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const MCP_CLIENT_INFO = { name: 'melete', version: '0.1.0' } as const;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** One server-sent event, as the web reader caps one page. */
const MAX_EVENT_BYTES = 1024 * 1024;
/** How deep a JSON message may nest; real tool schemas stay far shallower. */
export const MAX_JSON_DEPTH = 64;
/** How long a response body may go without a byte once it has begun. */
const IDLE_MS = 5_000;
/** Requests one HTTP connection may have open at once. */
const MAX_OPEN_PER_CONNECTION = 8;
/** Requests one space's connections may have open at once, together. */
const MAX_OPEN_PER_SPACE = 32;
const openBySpace = new Map<string, number>();
const TEMP_PREFIX = 'melete-mcp-';

/**
 * Whether a JSON text nests no deeper than `limit`, checked before it is
 * parsed, so a hostile answer cannot exhaust the parser's stack.
 */
export function jsonDepthWithin(text: string, limit = MAX_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (inString) {
      // A backslash escapes the character after it.
      if (code === 92) index++;
      else if (code === 34) inString = false;
    } else if (code === 34) inString = true;
    else if (code === 123 || code === 91) {
      if (++depth > limit) return false;
    } else if (code === 125 || code === 93) depth--;
  }
  return true;
}

export type McpEndpoint =
  | { transport: 'stdio'; command: string; args: string[] }
  | { transport: 'http'; url: string };

/** What a stateless server said about itself when asked with `server/discover`. */
export type McpDiscovery = { version: string; capabilities: JsonObject };

export interface McpTransport {
  request(
    method: string,
    params?: JsonObject,
    signal?: AbortSignal,
    /** Request headers beside the transport's own; only HTTP sends them. */
    headers?: Record<string, string>,
  ): Promise<unknown>;
  notify(method: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Asks whether the server speaks the stateless revision. On yes, every later
   * request is a stateless one and the answer says what the server offers; on
   * no, the caller makes the `initialize` handshake. Only HTTP asks.
   */
  discover?(): Promise<McpDiscovery | null>;
  /** The revision an `initialize` handshake settled on, which every later request names. */
  agreed?(version: string): void;
}

/** A JSON-RPC error, or an HTTP refusal that carried one, with its code and data kept. */
export class McpProtocolError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly code: number | undefined,
    readonly data: unknown,
  ) {
    super(status === undefined ? 'MCP server rejected the request' : `MCP HTTP status ${status}`);
  }
}

/** Errors only a server speaking the stateless revision sends; anything else is an older server. */
const UNSUPPORTED_VERSION = -32022;
const STATELESS_ERRORS = new Set([-32020, -32021, UNSUPPORTED_VERSION]);

export type McpTransportOptions = {
  timeoutMs?: number;
  maxMessageBytes?: number;
  /** How long a response may go silent once it has begun; 5 seconds unless set. */
  idleMs?: number;
  /**
   * Whose requests these are, for the limit on open requests across one
   * space's connections. Left out, only this connection's own limit applies.
   */
  space?: string;
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
  if (!jsonDepthWithin(text)) throw new Error('MCP message is nested too deeply');
  const value = jsonObject.parse(JSON.parse(text));
  if (value.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC version');
  return value as RpcMessage;
}

function rpcError(message: JsonObject, status?: number): McpProtocolError {
  const error = message.error;
  const fields = error && typeof error === 'object' && !Array.isArray(error) ? error : {};
  return new McpProtocolError(
    status,
    typeof fields.code === 'number' ? fields.code : undefined,
    fields.data,
  );
}

function resultOf(message: RpcMessage): unknown {
  if ('error' in message) throw rpcError(message);
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

/** Request methods whose `params.name` (or `params.uri`) the stateless revision mirrors into `Mcp-Name`. */
const NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);

/**
 * HTTP transport uses only the configured endpoint; redirects and client
 * capabilities are refused. It speaks the stateless revision (2026-07-28) to a
 * server that answers `server/discover`, and the session-based revisions
 * (2025-03-26 to 2025-11-25) to one that does not.
 */
export function openHttpMcpTransport(
  endpoint: Extract<McpEndpoint, { transport: 'http' }>,
  options: McpTransportOptions = {},
): McpTransport {
  const maxBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  let session: string | undefined;
  let counter = 0;
  let closed = false;
  /** Requests open on this connection now. */
  let open = 0;
  /** The revision every request names: the handshake's until a server proves it is stateless. */
  let version = MCP_PROTOCOL_VERSION;
  let stateless = false;
  const controllers = new Set<AbortController>();

  /** A stateless request carries its revision and the client's identity in `_meta`. */
  const statelessParams = (params: JsonObject | undefined, at: string): JsonObject => {
    const meta = params?._meta;
    return {
      ...params,
      _meta: {
        ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}),
        'io.modelcontextprotocol/protocolVersion': at,
        'io.modelcontextprotocol/clientInfo': { ...MCP_CLIENT_INFO },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    };
  };

  /** The headers the stateless revision requires: method, and name where the method has one. */
  const statelessHeaders = (message: JsonObject): Record<string, string> => {
    const method = String(message.method);
    const params = message.params as JsonObject | undefined;
    const name = params?.name ?? params?.uri;
    return {
      'Mcp-Method': mcpHeaderValue(method),
      ...(NAMED_METHODS.has(method) && typeof name === 'string'
        ? { 'Mcp-Name': mcpHeaderValue(name) }
        : {}),
    };
  };

  /** Reads a refused answer's JSON-RPC error, when it carries one, within the size limit. */
  async function refusal(response: Response): Promise<McpProtocolError> {
    const type = response.headers.get('content-type')?.split(';')[0]?.trim();
    const length = Number(response.headers.get('content-length') ?? 0);
    if (type !== 'application/json' || !response.body || length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return new McpProtocolError(response.status, undefined, undefined);
    }
    try {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) throw new Error('oversized');
      return rpcError(jsonObject.parse(JSON.parse(text)), response.status);
    } catch {
      return new McpProtocolError(response.status, undefined, undefined);
    }
  }

  async function post(
    message: JsonObject,
    signal?: AbortSignal,
    extra: { headers?: Record<string, string>; at?: string } = {},
  ): Promise<unknown> {
    if (closed) throw disconnected();
    // A request is refused before it is sent when too many are open, so the
    // refusal is certain: nothing reached the server.
    const counted = typeof message.method === 'string';
    if (counted) {
      const space = options.space;
      if (
        open >= MAX_OPEN_PER_CONNECTION ||
        (space !== undefined && (openBySpace.get(space) ?? 0) >= MAX_OPEN_PER_SPACE)
      )
        throw new ConnectorFaultError({
          kind: 'transient_before_dispatch',
          detail: 'Too many MCP requests are open at once; nothing was sent',
        });
      open++;
      if (space !== undefined) openBySpace.set(space, (openBySpace.get(space) ?? 0) + 1);
    }
    const controller = new AbortController();
    controllers.add(controller);
    /** Why this request was stopped, in words, when the transport stopped it. */
    let stopped: string | undefined;
    const abort = () => controller.abort();
    const stop = (reason: string) => () => {
      stopped ??= reason;
      controller.abort();
    };
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      stop('MCP server did not answer in time'),
      options.timeoutMs ?? 10_000,
    );
    let idle: ReturnType<typeof setTimeout> | undefined;
    let reader: { cancel(): Promise<void> } | undefined;
    const at = extra.at ?? version;
    const modern = extra.at !== undefined || stateless;
    try {
      const sent =
        modern && typeof message.method === 'string'
          ? {
              ...message,
              params: statelessParams(message.params as JsonObject | undefined, at),
            }
          : message;
      const body = JSON.stringify(sent);
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
          // Mirrored values first, so none of them can stand in for the transport's own.
          ...(modern ? { ...extra.headers, ...statelessHeaders(sent) } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': at,
          ...(session && !modern ? { 'MCP-Session-Id': session } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
      if (!response.ok) {
        // MCP session termination and HTTP authentication reject before tool execution.
        if (response.status === 404 && session && !modern) {
          await response.body?.cancel().catch(() => {});
          throw disconnected();
        }
        if (response.status === 403) {
          const challenge = bearerChallenge(response.headers.get('www-authenticate'));
          if (challenge?.error === 'insufficient_scope') {
            await response.body?.cancel().catch(() => {});
            await options.onInsufficientScope?.(challenge.scope ?? '').catch(() => {});
            // The person signs in again with more access; nobody is substituted.
            throw new ConnectorFaultError({
              kind: 'revoked_credential',
              detail: 'MCP server needs more access than was granted',
            });
          }
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => {});
          throw new ConnectorFaultError({
            kind: response.status === 401 ? 'expired_credential' : 'revoked_credential',
            detail:
              response.status === 401 ? 'MCP credential expired' : 'MCP credential was revoked',
          });
        }
        throw await refusal(response);
      }
      if (!('id' in message) || !('method' in message)) {
        await response.body?.cancel().catch(() => {});
        if (response.status !== 202) throw new Error('MCP notification was not acknowledged');
        return undefined;
      }
      const receivedSession = response.headers.get('mcp-session-id');
      // A stateless server has no sessions; a session id it sends is ignored.
      if (message.method === 'initialize' && receivedSession !== null && !modern) {
        if (!/^[\x21-\x7e]{1,256}$/.test(receivedSession))
          throw new Error('Invalid MCP session id');
        session = receivedSession;
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType !== 'application/json' && contentType !== 'text/event-stream') {
        throw new Error('Unsupported MCP response content type');
      }
      if (!response.body) throw new Error('Empty MCP response');
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new Error('MCP response limit exceeded');
      const bodyReader = response.body.getReader();
      reader = bodyReader;
      const decoder = new TextDecoder();
      const quiet = stop('MCP server stopped sending before it answered');
      const idleMs = options.idleMs ?? IDLE_MS;
      let buffer = '';
      let bytes = 0;
      for (;;) {
        clearTimeout(idle);
        idle = setTimeout(quiet, idleMs);
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
            if (Buffer.byteLength(data) > MAX_EVENT_BYTES)
              throw new Error('MCP event limit exceeded');
            const reply = parseMessage(data);
            if (typeof reply.method === 'string') {
              // A stateless server sends no requests of its own; one that does is refused.
              if (!modern && (typeof reply.id === 'string' || typeof reply.id === 'number')) {
                await post(unsupported(reply.id), controller.signal);
              }
            } else if (reply.id === message.id) return resultOf(reply);
            else throw new Error('MCP response id mismatch');
          }
        }
        // An event still arriving may not grow past one event's limit.
        if (contentType === 'text/event-stream' && Buffer.byteLength(buffer) > MAX_EVENT_BYTES)
          throw new Error('MCP event limit exceeded');
        if (chunk.done) throw new Error('MCP stream ended without an acknowledgement');
      }
    } catch (error) {
      // The transport's own limits say why; the call's outcome stays unknown.
      if (stopped) throw new Error(stopped);
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
      clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
      controllers.delete(controller);
      if (counted) {
        open--;
        const space = options.space;
        if (space !== undefined) {
          const left = (openBySpace.get(space) ?? 1) - 1;
          if (left > 0) openBySpace.set(space, left);
          else openBySpace.delete(space);
        }
      }
    }
  }

  return {
    request: (method, params, signal, headers) =>
      post({ jsonrpc: '2.0', id: ++counter, method, ...(params ? { params } : {}) }, signal, {
        ...(headers ? { headers } : {}),
      }),
    async notify(method) {
      // The stateless revision defines no notifications a client sends over HTTP.
      if (stateless) return;
      await post({ jsonrpc: '2.0', method });
    },
    async discover() {
      // The specification's probe: a stateless request first. A recognized
      // stateless error means a stateless server; anything else (another
      // refusal, an answer that is not one, silence until the timeout) means one
      // that wants the handshake. The probe acts on nothing, so falling back is
      // safe. Authentication and connection failures are neither, and are left
      // to the caller as they are.
      try {
        const answer = jsonObject.parse(
          await post({ jsonrpc: '2.0', id: ++counter, method: 'server/discover' }, undefined, {
            at: MCP_STATELESS_VERSION,
          }),
        );
        const supported = answer.supportedVersions;
        const capabilities = answer.capabilities;
        if (
          !Array.isArray(supported) ||
          !supported.includes(MCP_STATELESS_VERSION) ||
          !capabilities ||
          typeof capabilities !== 'object' ||
          Array.isArray(capabilities)
        )
          return null;
        stateless = true;
        version = MCP_STATELESS_VERSION;
        return { version, capabilities };
      } catch (error) {
        if (error instanceof ConnectorFaultError) throw error;
        if (closed) throw disconnected();
        if (!(error instanceof McpProtocolError)) return null;
        if (error.code === undefined || !STATELESS_ERRORS.has(error.code)) return null;
        if (error.code !== UNSUPPORTED_VERSION)
          throw new Error('MCP server refused the stateless request');
        // A stateless server that does not speak this revision: the handshake is
        // tried only when it names a revision Melete speaks that way.
        const named = (error.data as { supported?: unknown } | undefined)?.supported;
        if (
          Array.isArray(named) &&
          named.some((item) => typeof item === 'string' && MCP_HANDSHAKE_VERSIONS.includes(item))
        )
          return null;
        throw new Error('MCP server negotiated an unsupported protocol version');
      }
    },
    agreed(next) {
      if (!stateless) version = next;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      if (session && !stateless) {
        // Session disposal has no tool effect and is never used to replay a call.
        const token = await options.accessToken?.().catch(() => undefined);
        // The same fetch every request used, so closing is held to the same
        // address checks as talking was.
        const response = await (options.fetch ?? fetch)(endpoint.url, {
          method: 'DELETE',
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 10_000, 2_000)),
          headers: {
            'MCP-Protocol-Version': version,
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
