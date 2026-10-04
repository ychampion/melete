/**
 * A light engine for evaluation hosts without Docker.
 *
 * It answers the five calls of the pinned engine's HTTP surface that the real
 * `HermesRuntimeAdapter` uses (capabilities, start a run, its event stream,
 * stop, approval), so the adapter, broker, model gateway, ledger and fixture
 * destinations are exactly the ones the container path exercises. What it
 * replaces is the engine's own agent loop: one chat-completions loop that
 * forwards every tool call to the broker the same way the Melete plugin does
 * (`packages/runtime-hermes/melete_plugin`). It has no terminal, no
 * compaction and no engine hooks, and it holds no provider key: every model
 * request goes through the broker's metered gateway under the attempt's
 * capability, like the engine's own requests.
 *
 * A campaign records which engine ran it. A light-engine number is evidence
 * about the model with Melete's identity, catalog, broker and ledger; it is
 * not evidence about the pinned engine's loop.
 */
import { createHash, randomUUID } from 'node:crypto';
import { IDENTITY } from '../packages/runtime-hermes/src/instructions.ts';

export const LIGHT_ENGINE_VERSION = 'melete-evals-light/1';

type Json = Record<string, unknown>;
type CatalogTool = {
  name: string;
  description?: string;
  input_schema?: Json;
  connection_id?: string | null;
  effect_class?: string;
  execution?: string;
};
type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
type Run = {
  id: string;
  frames: Json[];
  listeners: Set<() => void>;
  done: boolean;
  stopped: boolean;
};

// The words the plugin gives the model, kept identical (melete_plugin/results.py).
const END_TURN_INSTRUCTION =
  "This action is waiting for the person's decision and has NOT happened. Stop now. Do not retry it, do not work around it, and do not say it is done. If this task also needs the person to answer a question, ask it with ask_person before you end; say a question is on their screen only when ask_person accepted it. End your turn with a short note of what you are waiting on. You will be started again with the decision once it has been made.";
const FAILURE_INSTRUCTION =
  'This action did not happen. Do not claim that it did. Either fix the cause and propose it again, or end your turn and say what blocked you.';
const UNCERTAIN_INSTRUCTION =
  'The broker cannot tell whether this action happened. Do NOT retry it and do NOT claim either outcome. End your turn and say that it is unconfirmed; the person will be asked.';
const OWN_COMPUTER_INSTRUCTION =
  'Whether this step happened on your own computer is not known. Do NOT repeat it yet and do NOT claim either outcome. Check first: take a screenshot, read the page, or look for the files or output it would have left, then carry on from what you find. The person is not asked about it.';
/** What the engine asks for when a run spends its iterations without a reply. */
export const STEP_LIMIT_NOTE =
  'You have reached the step limit for this turn. Reply to the person now with what you have, without calling a tool.';

class BrokerCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fromError(code: string, message: string): Json {
  const uncertain = code === 'unreachable';
  return {
    status: uncertain ? 'unknown' : 'failed',
    error: { code, message },
    instruction: uncertain ? UNCERTAIN_INSTRUCTION : FAILURE_INSTRUCTION,
  };
}

function needsApproval(response: Json): boolean {
  const status = response.status;
  return (
    status === 'needs_approval' ||
    ((status === undefined || status === null || status === 'proposed') &&
      Boolean(response.requires_approval))
  );
}

function fromResponse(response: Json, receipt?: unknown): Json {
  const status = response.status;
  if (needsApproval(response))
    return {
      status: 'needs_approval',
      action_id: response.action_id,
      approval_id: response.approval_id,
      payload_hash: response.payload_hash,
      instruction: END_TURN_INSTRUCTION,
    };
  if (status === 'succeeded')
    return {
      status: 'succeeded',
      action_id: response.action_id,
      ...(receipt === undefined || receipt === null ? {} : { receipt }),
    };
  if (status === 'unknown' || status === 'unresolved')
    return {
      status,
      action_id: response.action_id,
      instruction: response.own_computer ? OWN_COMPUTER_INSTRUCTION : UNCERTAIN_INSTRUCTION,
    };
  return {
    status: status ?? 'failed',
    action_id: response.action_id,
    instruction: FAILURE_INSTRUCTION,
  };
}

/** Python's `json.dumps(sort_keys=True)`, so a proposal reference matches the plugin's. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(', ')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${sortedJson((value as Json)[key])}`)
      .join(', ')}}`;
  return JSON.stringify(value);
}

export type LightEngineOptions = {
  brokerUrl: string;
  attemptToken: string;
  attemptId: string;
  jobId: string;
  provider: string;
  model: string;
  /** The bearer the adapter must present, like the engine's API_SERVER_KEY. */
  serverKey: string;
  maxTurns: number;
  maxTokens: number;
  /** Long enough for a sandbox command the broker runs before it answers. */
  toolTimeoutMs?: number;
};

export class LightEngine {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly runs = new Map<string, Run>();
  private readonly idempotency = new Map<string, string>();
  private readonly sessions = new Map<string, ChatMessage[]>();
  private readonly loaded = new Map<string, CatalogTool>();

  constructor(readonly options: LightEngineOptions) {}

  start(): string {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: (request) => this.route(request),
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop() {
    for (const run of this.runs.values()) run.stopped = true;
    await this.server?.stop(true);
  }

  private async route(request: Request): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${this.options.serverKey}`)
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/capabilities')
      return Response.json({
        platform: LIGHT_ENGINE_VERSION,
        model: this.options.model,
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          // Runs are keyed by Idempotency-Key for this engine's lifetime, which is the attempt's.
          runs_idempotency: { supported: true, durable: true },
        },
      });
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      const key = request.headers.get('idempotency-key') ?? randomUUID();
      const existing = this.idempotency.get(key);
      if (existing)
        return Response.json(
          { run_id: existing, status: 'started', replayed: true },
          { status: 202 },
        );
      const body = (await request.json()) as {
        input: string;
        instructions?: string;
        session_id: string;
      };
      const run: Run = {
        id: `run_${randomUUID()}`,
        frames: [],
        listeners: new Set(),
        done: false,
        stopped: false,
      };
      this.runs.set(run.id, run);
      this.idempotency.set(key, run.id);
      void this.execute(run, body).catch((error: unknown) =>
        this.emit(run, {
          event: 'run.failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json({ run_id: run.id, status: 'started' }, { status: 202 });
    }
    const match = /^\/v1\/runs\/([^/]+)\/(events|stop|approval)$/.exec(url.pathname);
    const run = match?.[1] ? this.runs.get(match[1]) : undefined;
    if (!match || !run) return Response.json({ error: 'not_found' }, { status: 404 });
    if (match[2] === 'stop') {
      run.stopped = true;
      return Response.json({ status: 'stopping' });
    }
    // The light engine has no shell guard of its own, so no approval is ever requested.
    if (match[2] === 'approval') return Response.json({ status: 'ignored' });
    return this.stream(run);
  }

  private stream(run: Run): Response {
    const encoder = new TextEncoder();
    let sent = 0;
    let notify: (() => void) | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start: async (controller) => {
          for (;;) {
            while (sent < run.frames.length) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(run.frames[sent])}\n\n`));
              sent++;
            }
            if (run.done) break;
            await new Promise<void>((resolve) => {
              notify = resolve;
              run.listeners.add(resolve);
            });
            if (notify) run.listeners.delete(notify);
          }
          controller.enqueue(encoder.encode(': stream closed\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
    );
  }

  private emit(run: Run, frame: Json) {
    if (run.done) return;
    run.frames.push({ ...frame, run_id: run.id, timestamp: Date.now() / 1000 });
    if (
      ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(
        String(frame.event),
      )
    )
      run.done = true;
    for (const listener of [...run.listeners]) listener();
  }

  private async broker(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000) {
    let response: Response;
    try {
      response = await fetch(`${this.options.brokerUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.attemptToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BrokerCallError(
        'unreachable',
        error instanceof Error ? error.message : String(error),
      );
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BrokerCallError(
        response.ok ? 'unreachable' : `http_${response.status}`,
        `broker returned HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      const detail = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new BrokerCallError(
        detail?.code ?? `http_${response.status}`,
        detail?.message ?? `broker returned HTTP ${response.status}`,
      );
    }
    return parsed as Json;
  }

  private async catalog(): Promise<CatalogTool[]> {
    const result = await this.broker('GET', '/tools');
    const served = Array.isArray(result.tools) ? (result.tools as CatalogTool[]) : [];
    const byName = new Map(served.map((tool) => [tool.name, tool]));
    for (const [name, tool] of this.loaded) if (!byName.has(name)) byName.set(name, tool);
    return [...byName.values()];
  }

  private clientRef(name: string, payload: Json, read: boolean) {
    const scope = read ? this.options.attemptId : this.options.jobId;
    const digest = createHash('sha256').update(sortedJson(payload)).digest('hex').slice(0, 32);
    return `${scope}:${name}:${digest}`;
  }

  /** The plugin's forwarding rules, one tool call at a time (melete_plugin/__init__.py). */
  private async call(tool: CatalogTool | undefined, name: string, args: Json): Promise<Json> {
    if (!tool) return fromError('unknown_tool', `${name} is not in this attempt's catalog`);
    const connection = tool.connection_id ?? null;
    try {
      if (name === 'react' && connection === null)
        return { status: 'succeeded', reaction: await this.broker('POST', '/reactions', args) };
      if (name === 'search_tools') return await this.broker('POST', '/tools/search', args);
      if (name === 'load_tool') {
        const loaded = await this.broker('POST', '/tools/load', args);
        const schema = loaded.tool as CatalogTool | undefined;
        if (!schema || typeof schema.name !== 'string')
          return fromError('invalid_catalog', 'The broker returned no tool schema.');
        this.loaded.set(schema.name, schema);
        return {
          status: 'tools_loaded',
          name: schema.name,
          schema_fingerprint: loaded.schema_fingerprint,
          instruction: 'The tool is loaded. This run will continue with its schema.',
        };
      }
      if (
        connection === null &&
        (name.startsWith('skills.') ||
          name.startsWith('run.') ||
          ['compose', 'chase.follow_up', 'ask_person'].includes(name))
      )
        return await this.broker('POST', '/tools/call', { name, arguments: args });
      if (name === 'learning.propose' && connection === null)
        return await this.broker('POST', '/tools/learning/propose', args);
      if (name === 'say' && connection === null)
        return await this.broker('POST', '/say', {
          text: String(args.text ?? ''),
          ref: this.clientRef(name, args, false),
        });
      if (name === 'job.wait' && connection === null)
        return await this.broker('POST', '/attempt/wait', args);
      if (name === 'resume_action' && connection === null) {
        const actionId = args.action_id;
        if (typeof actionId !== 'string' || !actionId)
          return fromError('payload_invalid', 'resume_action needs the approved action_id.');
        return await this.settle(
          await this.broker('POST', `/actions/${encodeURIComponent(actionId)}/resume`, {}),
        );
      }
      if (!connection)
        return fromError('unknown_connection', `${name} has no connection in the catalog`);
      if (tool.execution === 'in_cell')
        return fromError('unknown_tool', `${name} cannot be carried out in this runtime`);
      const response = await this.broker(
        'POST',
        '/actions',
        {
          kind: name,
          connection_id: connection,
          payload: args,
          client_ref: this.clientRef(name, args, tool.effect_class === 'read'),
        },
        this.options.toolTimeoutMs ?? 240_000,
      );
      return await this.settle(response);
    } catch (error) {
      if (error instanceof BrokerCallError) return fromError(error.code, error.message);
      throw error;
    }
  }

  private async settle(response: Json): Promise<Json> {
    if (needsApproval(response)) return fromResponse(response);
    let receipt: unknown;
    if (response.status === 'succeeded' && response.action_id) {
      try {
        const read = await this.broker('GET', `/actions/${String(response.action_id)}`);
        receipt = (read.action as Json | undefined)?.receipt;
      } catch {
        // The action still succeeded; it is reported without its receipt.
      }
    }
    return fromResponse(response, receipt);
  }

  private async model(messages: ChatMessage[], tools: CatalogTool[], allowTools: boolean) {
    const response = await fetch(
      `${this.options.brokerUrl.replace(/\/+$/, '')}/providers/${this.options.provider}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-evals',
          'x-melete-capability': this.options.attemptToken,
        },
        body: JSON.stringify({
          model: this.options.model,
          messages,
          max_tokens: this.options.maxTokens,
          stream: false,
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description ?? '',
                    parameters: tool.input_schema ?? { type: 'object', properties: {} },
                  },
                })),
                tool_choice: allowTools ? 'auto' : 'none',
              }
            : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    const text = await response.text();
    if (!response.ok)
      throw new Error(`model gateway answered ${response.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as {
      choices?: { message?: { content?: string | null; tool_calls?: ChatMessage['tool_calls'] } }[];
      usage?: { completion_tokens?: number };
    };
    const message = body.choices?.[0]?.message ?? {};
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: (message.tool_calls ?? []).filter((call) => call?.function?.name),
      outputTokens: Number(body.usage?.completion_tokens ?? 0),
    };
  }

  private async execute(
    run: Run,
    body: { input: string; instructions?: string; session_id: string },
  ) {
    let messages = this.sessions.get(body.session_id);
    if (!messages) {
      messages = [
        { role: 'system', content: [IDENTITY, body.instructions].filter(Boolean).join('\n\n') },
      ];
      this.sessions.set(body.session_id, messages);
    }
    messages.push({ role: 'user', content: body.input });
    let outputTokens = 0;
    const tools = await this.catalog();
    for (let turn = 0; turn <= this.options.maxTurns; turn++) {
      if (run.stopped) return this.emit(run, { event: 'run.cancelled' });
      const last = turn === this.options.maxTurns;
      if (last) messages.push({ role: 'user', content: STEP_LIMIT_NOTE });
      const reply = await this.model(messages, tools, !last);
      outputTokens += reply.outputTokens;
      if (process.env.EVALS_ENGINE_TRACE === '1')
        console.error(`engine: model call ${turn + 1}, ${reply.toolCalls.length} tool calls`);
      const calls = last ? [] : reply.toolCalls;
      messages.push({
        role: 'assistant',
        content: reply.content || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      if (reply.content) this.emit(run, { event: 'message.delta', delta: reply.content });
      if (!calls.length) {
        return this.emit(run, {
          event: 'run.completed',
          output: reply.content,
          usage: { output_tokens: outputTokens },
        });
      }
      for (const call of calls) {
        const name = call.function.name;
        let args: Json = {};
        let parsed = true;
        try {
          const value = JSON.parse(call.function.arguments || '{}');
          if (value && typeof value === 'object' && !Array.isArray(value)) args = value as Json;
          else parsed = false;
        } catch {
          parsed = false;
        }
        this.emit(run, {
          event: 'tool.started',
          tool: name,
          preview: call.function.arguments.slice(0, 200),
        });
        const started = Date.now();
        const result = parsed
          ? await this.call(
              tools.find((tool) => tool.name === name) ?? this.loaded.get(name),
              name,
              args,
            )
          : fromError('payload_invalid', 'The tool arguments were not a JSON object.');
        if (result.status === 'tools_loaded') {
          const schema = this.loaded.get(String(result.name));
          if (schema && !tools.some((tool) => tool.name === schema.name)) tools.push(schema);
        }
        this.emit(run, {
          event: 'tool.completed',
          tool: name,
          duration: (Date.now() - started) / 1000,
          error: ['failed', 'unknown'].includes(String(result.status)),
        });
        // Opt-in trace for debugging a scenario; tool results are fixture data, never secrets.
        if (process.env.EVALS_ENGINE_TRACE === '1')
          console.error(
            `engine: ${name} ${JSON.stringify(args).slice(0, 300)} -> ${JSON.stringify(result).slice(0, 600)}`,
          );
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  }
}
