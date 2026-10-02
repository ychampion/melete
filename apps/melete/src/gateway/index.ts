import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { SecureContextOptions, TLSSocket } from 'node:tls';
import {
  GATEWAY_MAX_REQUEST_BYTES,
  inputTokenAllowance,
  modelContextWindow,
  REQUEST_FRAMING_TOKENS,
} from '@melete/contracts';
import { localEndpoint, PrivacyRouter } from '../privacy/index.ts';
import { createScriptedProvider, fakeProvider } from './fake.ts';
import { countImages, imageTokens, isInlineImage } from './images.ts';
import { trackModelCall } from './inflight.ts';
import { estimateInputTokens, object, SecretRedactor, UsageCollector } from './metering.ts';
import {
  checkConnectTarget,
  PROVIDER_HOSTS,
  providersFromEnv,
  requiresResponsesProtocol,
  resolveRoute,
} from './providers.ts';
import {
  type GatewayBudget,
  GatewayError,
  type GatewayPrincipal,
  type GatewayProvider,
  type GatewayReservation,
  type GatewaySettlement,
} from './types.ts';

export * from './fake.ts';
export * from './providers.ts';
export * from './types.ts';

export interface GatewayOptions {
  authenticate(token: string): Promise<GatewayPrincipal>;
  budget: GatewayBudget;
  providers?: GatewayProvider[];
  /**
   * The providers as they stand for one request, given the configured ones.
   * Keys and endpoints the owner connects in the app are added here, so a
   * change applies to the next model call without a restart.
   */
  currentProviders?: (configured: GatewayProvider[]) => Promise<GatewayProvider[]>;
  defaultProvider?: string;
  /** Test injection or a service-owned transport; never selected by a request. */
  fetch?: (request: Request) => Promise<Response>;
  fake?: ReturnType<typeof createScriptedProvider>;
  /** How long a provider may go without sending anything before the call ends. */
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /**
   * The output limit given to a request that names none. The pinned engine
   * sends none unless its configuration sets one, so this is the usual ceiling
   * on a reply. It never exceeds what the attempt may still spend.
   */
  defaultMaxTokens?: number;
  /** Cert must cover this host and be trusted by the runtime's internal CA store. */
  connectTls?: (host: string) => Pick<SecureContextOptions, 'key' | 'cert' | 'ca'> | undefined;
  /** Ledger failures must reach service monitoring; no response may claim a persisted success. */
  onError?: (error: Error) => void;
  /** The broker shares this internal listener; it applies its own attempt/API authorization. */
  brokerFetch?: (request: Request) => Response | Promise<Response>;
  /**
   * Decides where each request may go and swaps sensitive details for
   * placeholders. Required, so a new gateway cannot be opened without choosing
   * its router; `false` sends requests as written and is only for tests of the
   * transport.
   */
  privacy: PrivacyRouter | false;
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function capability(request: IncomingMessage): string {
  const token = header(request, 'x-melete-capability');
  if (token) return token;
  const match = /^Bearer ([^\s]+)$/.exec(header(request, 'proxy-authorization'));
  if (!match?.[1]) throw new GatewayError(401, 'capability_required');
  return match[1];
}

function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const failure = error instanceof GatewayError ? error : new GatewayError(502, 'gateway_failure');
  response.writeHead(failure.status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(JSON.stringify({ error: { code: failure.code, message: failure.code } }));
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(header(request, 'content-type'))) {
    throw new GatewayError(415, 'json_required');
  }
  const contentLength = header(request, 'content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new GatewayError(413, 'request_too_large');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new GatewayError(413, 'request_too_large');
    chunks.push(bytes);
  }
  try {
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (body) return body;
  } catch {
    // Keep parser details and request content out of error responses.
  }
  throw new GatewayError(400, 'invalid_json');
}

/** The output limit for a request that names none. A few hundred tokens truncates ordinary replies. */
export const DEFAULT_MAX_TOKENS = 4096;

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function createModelGateway(options: GatewayOptions): Server {
  // Checked at run time too, for a caller that reached here around the type.
  if (options.privacy !== false && !(options.privacy instanceof PrivacyRouter))
    throw new TypeError('A model gateway needs a privacy router');
  const providers = options.providers ?? [...providersFromEnv(), fakeProvider];
  const allowedHosts = new Set<string>(PROVIDER_HOSTS);
  for (const provider of providers) {
    if (!provider.fake) allowedHosts.add(new URL(provider.baseUrl).hostname);
  }
  const fake = options.fake ?? createScriptedProvider();
  const transport = options.fetch ?? ((request: Request) => fetch(request));
  const maxRequestBytes = options.maxRequestBytes ?? GATEWAY_MAX_REQUEST_BYTES;
  const defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  if (!positiveInteger(defaultMaxTokens))
    throw new RangeError('The default output limit must be a positive integer');
  const secrets = providers
    .map((provider) => provider.apiKey)
    .filter((key): key is string => !!key);
  const sockets = new Set<Duplex>();
  const reportError = (error: unknown) =>
    options.onError?.(
      new Error(error instanceof GatewayError ? error.code : 'gateway_ledger_failure'),
    );

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    inherited?: { principal: GatewayPrincipal; host: string },
  ) => {
    let reservation: GatewayReservation | undefined;
    let settlement: GatewaySettlement | undefined;
    let settled = false;
    // Kept here so a call that is stopped part way can still be charged for what it streamed.
    let collector: UsageCollector | undefined;
    let charged: { input: number; output: number } | undefined;
    const started = performance.now();
    const abort = new AbortController();
    // A limit on silence, not on length: each chunk from the provider restarts
    // it, so a long answer that keeps arriving is not cut off part way and
    // asked for again from the start. A provider that goes quiet still ends.
    const idleMs = options.timeoutMs ?? 60_000;
    let timer = setTimeout(() => abort.abort(), idleMs);
    const heard = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), idleMs);
    };
    const cancelled = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.once('close', cancelled);
    // Set when the attempt this call is for was stopped, so its receipt says so.
    let stopped = false;
    let untrack = () => {};
    try {
      if (request.method !== 'POST') throw new GatewayError(405, 'method_denied');
      const principal = inherited?.principal ?? (await options.authenticate(capability(request)));
      untrack = trackModelCall({
        jobId: principal.jobId,
        attemptId: principal.attemptId,
        stop: () => {
          stopped = true;
          if (settlement) settlement.stopped = true;
          abort.abort();
        },
      });
      let target = request.url ?? '';
      if (inherited) {
        if (!target.startsWith('/') || target.startsWith('//')) {
          throw new GatewayError(403, 'destination_denied');
        }
        const host = header(request, 'host').toLowerCase();
        if (host !== inherited.host && host !== `${inherited.host}:443`) {
          throw new GatewayError(403, 'destination_denied');
        }
        target = `https://${inherited.host}${target}`;
      }
      const { provider, protocol, upstream } = resolveRoute(
        target,
        options.currentProviders ? await options.currentProviders(providers) : providers,
        options.defaultProvider ?? 'fireworks',
      );
      const surrogate =
        protocol === 'messages'
          ? header(request, 'x-api-key')
          : header(request, 'authorization').replace(/^Bearer /, '');
      if (!/^melete-surrogate-[A-Za-z0-9_-]+$/.test(surrogate)) {
        throw new GatewayError(401, 'surrogate_required');
      }
      const body = await readBody(request, maxRequestBytes);
      const model = body.model;
      if (typeof model !== 'string' || !model || model.length > 300) {
        throw new GatewayError(400, 'model_required');
      }
      if (
        !principal.allowedModels.some(
          (choice) => choice.provider === provider.name && choice.model === model,
        )
      ) {
        throw new GatewayError(403, 'model_denied');
      }
      if (requiresResponsesProtocol(model) && protocol !== 'responses') {
        throw new GatewayError(400, 'responses_required');
      }
      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        throw new GatewayError(400, 'invalid_stream');
      }
      // A multiplied completion count would evade the single-output reservation.
      if (body.n !== undefined && body.n !== 1)
        throw new GatewayError(400, 'multiple_outputs_denied');
      const limitKey = protocol === 'responses' ? 'max_output_tokens' : 'max_tokens';
      // A limit the runtime names is honoured or refused, never rewritten. One
      // it leaves out is filled in, bounded by what the attempt may still spend,
      // so the substitute cannot itself be the reason a call is refused.
      const requested =
        body.max_output_tokens ??
        body.max_completion_tokens ??
        body.max_tokens ??
        Math.min(
          defaultMaxTokens,
          principal.maxTokens,
          principal.remainingTokens ?? principal.maxTokens,
        );
      if (!positiveInteger(requested) || requested > principal.maxTokens) {
        throw new GatewayError(429, 'token_cap_exceeded');
      }
      // An output cap that leaves no room even for the framing can never fit,
      // however short the conversation. It is refused as itself, because the
      // engine reads input_context_exceeded as a cue to compact, and compacting
      // cannot help a request like this one.
      if (requested > modelContextWindow(model) - REQUEST_FRAMING_TOKENS)
        throw new GatewayError(400, 'output_exceeds_context');
      for (const key of ['max_output_tokens', 'max_completion_tokens', 'max_tokens'])
        delete body[key];
      body[
        protocol === 'chat/completions' && provider.name === 'openai'
          ? 'max_completion_tokens'
          : limitKey
      ] = requested;
      if (protocol === 'messages') {
        // Anthropic's current API rejects these controls. History remains append-only and untouched.
        for (const key of ['temperature', 'top_p', 'top_k']) delete body[key];
      } else if (protocol === 'chat/completions' && body.stream) {
        body.stream_options = { include_usage: true };
      }
      // The engine's own estimate of the request body, plus framing. It has to
      // be the engine's, because the engine decides when to compact by it:
      // counting a token per byte instead refused a request roughly four times
      // sooner than the engine's trigger, so a long conversation was rejected
      // here before it could ever be compacted.
      // Remote media and built-in tools cannot be metered by this gateway. A
      // picture the request carries itself (a screenshot the agent took) can,
      // within the limits countImages holds it to.
      if (containsRemoteInput(body)) throw new GatewayError(400, 'unmetered_input_denied');
      countImages(body);
      // Where this request may go and what it may carry: private conversations
      // go to the person's own model, everything else leaves with its sensitive
      // details swapped for placeholders. A refusal happens before anything is
      // reserved, and nothing below sees the unredacted body again.
      const router = options.privacy === false ? null : options.privacy;
      const prepared = router
        ? await router.prepare({ principal, provider, protocol, body })
        : null;
      const outbound = prepared?.body ?? body;
      const local = prepared?.local ?? null;
      const encoded = JSON.stringify(outbound);
      // A picture is charged as the flat count the engine compacts by, not as
      // the base64 text it travels in.
      const pictures = imageTokens(outbound);
      const inputTokens =
        estimateInputTokens(pictures.text === outbound ? encoded : JSON.stringify(pictures.text)) +
        pictures.tokens +
        REQUEST_FRAMING_TOKENS;
      if (
        inputTokens >
        inputTokenAllowance(model, requested, { max_input_tokens: principal.maxInputTokens })
      )
        throw new GatewayError(413, 'input_context_exceeded');
      const estimatedTokens = inputTokens + requested;
      if (!local && !provider.fake && !provider.apiKey && !provider.signedIn)
        throw new GatewayError(503, 'provider_key_unavailable');
      // Opened before anything is reserved, so a provider nobody is signed in
      // to refuses the call without charging the job.
      const signedIn = local || provider.fake ? undefined : await provider.signedIn?.current();
      const credential = local ? local.apiKey : (signedIn?.token ?? provider.apiKey);
      reservation = await options.budget.reserve({
        principal,
        requestId: randomUUID(),
        provider: provider.name,
        model,
        estimatedTokens,
        maxOutputTokens: requested,
      });
      settlement = {
        provider: provider.name,
        modelRequested: model,
        modelActual: null,
        usage: null,
        latencyMs: 0,
        status: 'unknown',
        httpStatus: null,
        ...(prepared ? { privacy: prepared.receipt } : {}),
        ...(stopped ? { stopped } : {}),
      };
      if (abort.signal.aborted) throw new GatewayError(504, 'request_aborted');
      const headers = new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      });
      for (const [name, value] of Object.entries(signedIn?.headers ?? {})) headers.set(name, value);
      if (local) {
        if (credential) headers.set('authorization', `Bearer ${credential}`);
        // The router pinned the local model to the address it checked for this request.
        if (local.host) headers.set('host', local.host);
      } else if (protocol === 'messages') {
        headers.set('x-api-key', credential ?? 'fake');
        headers.set('anthropic-version', '2023-06-01');
      } else headers.set('authorization', `Bearer ${credential ?? 'fake'}`);
      const result =
        provider.fake && !local
          ? await fake(outbound, principal.attemptId, protocol)
          : await transport(
              new Request((local ? localEndpoint(local, 'chat/completions') : upstream).href, {
                method: 'POST',
                headers,
                body: encoded,
                redirect: 'error',
                signal: abort.signal,
              }),
            );
      settlement.httpStatus = result.status;
      heard();
      if (!result.ok || !result.body) {
        // Provider errors may contain injected keys or internal request diagnostics.
        await result.body?.cancel();
        settlement.status = 'failed';
        if (signedIn && result.status === 401) provider.signedIn?.rejected(signedIn.generation);
        throw new GatewayError(result.status === 429 ? 429 : 502, 'provider_rejected_request');
      }
      const streaming = body.stream === true;
      const contentType = result.headers.get('content-type') ?? '';
      if (
        streaming
          ? !contentType.includes('text/event-stream')
          : !contentType.includes('application/json')
      ) {
        await result.body.cancel();
        throw new GatewayError(502, 'unexpected_provider_response');
      }
      collector = new UsageCollector(streaming, options.maxResponseBytes);
      charged = { input: inputTokens, output: requested };
      const redactor = new SecretRedactor(
        [...secrets, signedIn?.token, local?.apiKey].filter((key): key is string => !!key),
      );
      // Real values go back in before the reply leaves the gateway; the
      // provider's placeholders are all the provider ever saw.
      const rehydrator = prepared?.rehydrator ?? null;
      const buffered: string[] = [];
      if (streaming) {
        response.writeHead(result.status, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
        });
      }
      const reader = result.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          heard();
          collector.feed(value);
          settlement.modelActual = collector.modelActual;
          const output = redactor.feed(value);
          if (streaming) {
            const visible = rehydrator && output ? rehydrator.push(output) : output;
            if (visible) await writeChunk(response, visible, abort.signal);
          } else buffered.push(output);
        }
        collector.finish();
      } finally {
        await reader.cancel().catch(() => {});
      }
      const rest = redactor.feed(new Uint8Array(), true);
      const tail = streaming && rehydrator ? rehydrator.push(rest) + rehydrator.end() : rest;
      settlement.modelActual = collector.modelActual;
      settlement.usage = collector.completed ? collector.usage : null;
      settlement.status = collector.completed ? 'succeeded' : 'unknown';
      settlement.latencyMs = Math.round(performance.now() - started);
      // End-of-stream or the JSON result is released only after its evidence is durable.
      await options.budget.settle(reservation, settlement);
      settled = true;
      if (!collector.completed) throw new GatewayError(502, 'incomplete_provider_response');
      if (streaming) response.end(tail);
      else {
        response.writeHead(result.status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        const whole = buffered.join('') + tail;
        response.end(rehydrator ? rehydrator.json(whole) : whole);
      }
    } catch (error) {
      // Rejections can answer before the POST body was read, and an unread body
      // outlives the response on Bun's HTTP server (see drainRequest).
      await drainRequest(request, maxRequestBytes);
      if (reservation && settlement && !settled) {
        settlement.latencyMs = Math.round(performance.now() - started);
        // A call stopped part way is charged what it streamed, estimated,
        // rather than its whole output allowance.
        if (stopped && !settlement.usage && collector && charged) {
          settlement.usage = collector.estimate(charged.input, charged.output);
          settlement.usageEstimated = true;
        }
        try {
          await options.budget.settle(reservation, settlement);
        } catch (ledgerError) {
          reportError(ledgerError);
        }
      }
      fail(response, error);
    } finally {
      untrack();
      clearTimeout(timer);
      response.removeListener('close', cancelled);
    }
  };

  const server = createServer((request, response) => {
    if (
      options.brokerFetch &&
      (/^\/(tools|actions)(?:\/|$|\?)/.test(request.url ?? '') || request.url === '/attempt/wait')
    ) {
      void forwardToBroker(request, response, options.brokerFetch).catch(async (error) => {
        await drainRequest(request, maxRequestBytes);
        fail(response, error);
      });
    } else void handle(request, response);
  });
  server.requestTimeout = options.timeoutMs ?? 60_000;
  server.headersTimeout = Math.min(server.requestTimeout, 10_000);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, socket, head) => {
    void (async () => {
      try {
        checkConnectTarget(request.url ?? '', allowedHosts);
        const principal = await options.authenticate(capability(request));
        const host = (request.url ?? '').slice(0, -4).toLowerCase();
        const tls = options.connectTls?.(host);
        if (!tls?.key || !tls.cert) throw new GatewayError(403, 'metered_endpoint_required');
        // Bun does not support attaching its HTTP parser by emitting Node's connection event.
        // A loopback-only TLS listener gives the tunnel a real parser on both runtimes.
        const secured = createHttpsServer({ ...tls, ALPNProtocols: ['http/1.1'] }, (req, res) => {
          const servername = (req.socket as TLSSocket).servername;
          if (servername && servername !== host) {
            fail(res, new GatewayError(403, 'destination_denied'));
            return;
          }
          void handle(req, res, { principal, host });
        });
        secured.maxConnections = 1;
        secured.on('tlsClientError', () => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          secured.once('error', reject);
          secured.listen(0, '127.0.0.1', resolve);
        });
        const address = secured.address();
        if (!address || typeof address === 'string')
          throw new GatewayError(502, 'tls_listener_failed');
        const bridge = connect(address.port, '127.0.0.1');
        const dispose = () => {
          bridge.destroy();
          secured.closeAllConnections();
          secured.close();
        };
        socket.once('close', dispose);
        bridge.once('error', () => socket.destroy());
        bridge.once('connect', () => {
          if (socket.destroyed) return dispose();
          (socket as Socket).setTimeout(options.timeoutMs ?? 60_000, () => socket.destroy());
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) bridge.write(head);
          socket.pipe(bridge).pipe(socket);
        });
      } catch (error) {
        const failure =
          error instanceof GatewayError ? error : new GatewayError(401, 'capability_denied');
        socket.end(
          `HTTP/1.1 ${failure.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\nX-Melete-Error: ${failure.code}\r\n\r\n`,
        );
      }
    })();
  });
  // closeAllConnections drops idle keep-alive clients that would otherwise hold
  // the listener open; it excludes upgraded CONNECT sockets, so those are next.
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void) => {
    const closing = close(callback);
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    return closing;
  };
  return server;
}

/**
 * Bun's HTTP server keeps a request on its in-flight list until the body is
 * read, and server.close() never runs its callback while one is still listed,
 * even after the listener stops and every socket is destroyed. A response that
 * rejects before reading the body therefore has to drain it, and has to finish
 * draining before it ends the response: request.resume() only schedules flowing
 * mode, so response.end() in the same tick still leaves the body unread.
 */
async function drainRequest(request: IncomingMessage, limitBytes: number): Promise<void> {
  if (request.readableEnded || request.destroyed) return;
  let size = 0;
  try {
    for await (const chunk of request) {
      size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      // An already-refused request may not hold the internal exit open forever.
      if (size > limitBytes) break;
    }
  } catch {
    // A client that disconnects mid-body has already released the request.
  }
}

async function forwardToBroker(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: NonNullable<GatewayOptions['brokerFetch']>,
): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of incoming) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1_048_576) throw new GatewayError(413, 'request_too_large');
    chunks.push(data);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = incoming.method ?? 'GET';
  const response = await handler(
    new Request(`http://broker.internal${incoming.url}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    }),
  );
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function containsRemoteInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRemoteInput);
  const node = object(value);
  if (!node) return false;
  if (isInlineImage(node)) return false;
  if (
    typeof node.type === 'string' &&
    /image|audio|video|file|web_search|computer|code_interpreter/.test(node.type)
  ) {
    return true;
  }
  return Object.values(node).some(containsRemoteInput);
}

async function writeChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw new GatewayError(504, 'request_aborted');
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      response.removeListener('drain', drained);
      response.removeListener('close', closed);
      signal.removeEventListener('abort', closed);
    };
    const drained = () => {
      finish();
      resolve();
    };
    const closed = () => {
      finish();
      reject(new GatewayError(504, 'request_aborted'));
    };
    response.once('drain', drained);
    response.once('close', closed);
    signal.addEventListener('abort', closed, { once: true });
  });
}
