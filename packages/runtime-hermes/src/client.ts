/**
 * A typed client for the pinned Hermes release's HTTP surface. It builds
 * requests and parses responses; it never opens a socket, so the whole thing is
 * testable without a container.
 *
 * The six calls Melete uses, all read from the tag rather than assumed
 * (`gateway/platforms/api_server_runs.py:101`,
 * `gateway/platforms/api_server.py:1503`):
 *
 *   GET  /v1/capabilities          what this build supports
 *   POST /v1/runs                  start one bounded attempt
 *   GET  /v1/runs/{id}             status
 *   GET  /v1/runs/{id}/events      the SSE stream, consumed exactly once
 *   POST /v1/runs/{id}/approval    answer a shell-command notification
 *   POST /v1/runs/{id}/stop        cancel
 *
 * `/v1/runs/{id}/steer` exists and is deliberately not used: a mid-run
 * instruction that never reached the ledger is exactly the untracked side
 * channel the broker exists to prevent.
 */
import type { AttemptBundle } from '@melete/contracts';
import { z } from 'zod';
import { renderInput, renderInstructions } from './instructions.ts';

export const HERMES_ROUTES = {
  capabilities: '/v1/capabilities',
  runs: '/v1/runs',
  status: (runId: string) => `/v1/runs/${runId}`,
  events: (runId: string) => `/v1/runs/${runId}/events`,
  approval: (runId: string) => `/v1/runs/${runId}/approval`,
  stop: (runId: string) => `/v1/runs/${runId}/stop`,
} as const;

export type HermesRequest = {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
};

/**
 * The statuses a run can hold. `interrupted` and `cancelled` are terminal on the
 * engine's side (`api_server_run_idempotency.py:17`); `stopping` is what a run
 * shows between `/stop` and the executor noticing.
 */
export const HERMES_RUN_STATUSES = [
  'queued',
  'started',
  'running',
  'stopping',
  'waiting_for_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export const hermesRunStatus = z.object({
  run_id: z.string(),
  status: z.enum(HERMES_RUN_STATUSES).catch('running'),
  error: z.string().nullable().optional(),
  output: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  last_event: z.string().optional(),
});
export type HermesRunStatus = z.infer<typeof hermesRunStatus>;

/** `POST /v1/runs` answers 202 with this (`api_server_runs.py:288`). */
export const hermesRunAccepted = z.object({
  run_id: z.string().min(1),
  status: z.string(),
  /** True when the idempotency key matched a run that was already admitted. */
  replayed: z.boolean().default(false),
});
export type HermesRunAccepted = z.infer<typeof hermesRunAccepted>;

/**
 * `GET /v1/capabilities`. Only the parts Melete acts on are modelled; the rest
 * of the body is large and is not ours to validate.
 */
export const hermesCapabilities = z.object({
  platform: z.string().optional(),
  model: z.string().optional(),
  features: z
    .object({
      run_submission: z.boolean().optional(),
      run_events_sse: z.boolean().optional(),
      run_stop: z.boolean().optional(),
      run_approval_response: z.boolean().optional(),
      runs_idempotency: z
        .object({
          supported: z.boolean().default(false),
          durable: z.boolean().default(false),
          retention_seconds: z.number().optional(),
        })
        .optional(),
    })
    .default({}),
});
export type HermesCapabilities = z.infer<typeof hermesCapabilities>;

/**
 * What the gateway notifier sends when a shell command needs a decision. Melete
 * does not route its own tool approvals through this; it exists so that a shell
 * command, if one ever appears, surfaces instead of silently denying.
 */
export const hermesApprovalRequest = z.object({
  request_id: z.string(),
  command: z.string().optional(),
  description: z.string().optional(),
  pattern_key: z.string().optional(),
  pattern_keys: z.array(z.string()).optional(),
  allow_session: z.boolean().optional(),
  allow_permanent: z.boolean().optional(),
});
export type HermesApprovalRequest = z.infer<typeof hermesApprovalRequest>;

/**
 * Melete answers `once` or `deny` and nothing else. A session-wide or permanent
 * allowance would outlive the attempt it was granted for, which is exactly the
 * property the broker exists to prevent.
 */
export const HERMES_APPROVAL_ANSWERS = ['once', 'deny'] as const;
export type HermesApprovalAnswer = (typeof HERMES_APPROVAL_ANSWERS)[number];

export type HermesClientOptions = {
  baseUrl: string;
  /** The API server's bearer, when one is configured (`API_SERVER_KEY`). */
  token?: string;
};

/** Internal continuation state; it does not extend the frozen attempt contract. */
export type HermesContinuation = {
  index?: number;
  input?: string;
};

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

export class HermesClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: HermesClientOptions) {
    this.baseUrl = trimSlash(options.baseUrl);
    this.token = options.token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  capabilities(): HermesRequest {
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.capabilities}`,
      method: 'GET',
      headers: this.headers(),
    };
  }

  /**
   * Start a run from an attempt bundle.
   *
   * `Idempotency-Key` is the attempt id, so a resent POST resolves to the run
   * that already exists rather than starting a second one. The session key is
   * the job id: consecutive attempts on one job continue the same Hermes
   * session, which is what lets an approved action resume where it parked.
   *
   * Nothing here configures the engine. Toolsets, memory, context files and the
   * provider all come from the image's `config.yaml`, because the `/v1/runs`
   * body has no fields for them: `_create_agent` reads them from config
   * (`gateway/platforms/api_server.py:2087`). Sending `toolsets: []` in this
   * body, as the skeleton did, has no effect at all.
   */
  startRun(bundle: AttemptBundle, continuation: HermesContinuation = {}): HermesRequest {
    const body = {
      input: continuation.input ?? renderInput(bundle),
      instructions: renderInstructions(bundle),
      session_id: bundle.attempt.job_id,
      model: bundle.model.model,
    };
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.runs}`,
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        'Idempotency-Key': continuation.index
          ? `${bundle.attempt.id}:tools:${continuation.index}`
          : bundle.attempt.id,
        'X-Hermes-Session-Key': bundle.attempt.job_id,
      }),
      body: JSON.stringify(body),
    };
  }

  status(runId: string): HermesRequest {
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.status(runId)}`,
      method: 'GET',
      headers: this.headers(),
    };
  }

  /**
   * The event stream. It is an in-memory queue with no replay
   * (`api_server_runs.py:154`), so there is no reconnecting to catch up: Melete
   * consumes it once, persists before fan-out, and treats a dropped stream as a
   * dead attempt. `Last-Event-ID` is not sent, because nothing would honour it.
   */
  events(runId: string): HermesRequest {
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.events(runId)}`,
      method: 'GET',
      headers: this.headers({ accept: 'text/event-stream' }),
    };
  }

  approve(runId: string, requestId: string, answer: HermesApprovalAnswer): HermesRequest {
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.approval(runId)}`,
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ request_id: requestId, choice: answer }),
    };
  }

  stop(runId: string): HermesRequest {
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.stop(runId)}`,
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    };
  }

  /** Kept as methods so a caller can see what a run will be told without sending it. */
  renderSystem(bundle: AttemptBundle): string {
    return renderInstructions(bundle);
  }

  renderInput(bundle: AttemptBundle): string {
    return renderInput(bundle);
  }
}

export { IDENTITY } from './instructions.ts';

// --------------------------------------------------------------------------
// SSE parsing
// --------------------------------------------------------------------------

export type SseMessage = {
  id?: string;
  event?: string;
  data: string;
};

/**
 * Split a Server-Sent Events buffer into complete messages, returning whatever
 * is left over so a caller can feed the next chunk in. Deliberately dumb: no
 * network, no state beyond the remainder.
 *
 * Hermes writes bare comment lines as keepalives every 30 seconds and one more
 * (`: stream closed`) when the run ends, so a chunk with no fields at all is
 * normal and is dropped here rather than surfaced as an empty event.
 */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    const message: SseMessage = { data: '' };
    const dataLines: string[] = [];
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith(':') || line.trim() === '') continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') message.id = value;
      else if (field === 'event') message.event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0 && !message.event) continue;
    message.data = dataLines.join('\n');
    messages.push(message);
  }

  return { messages, rest };
}

/**
 * One frame off the run stream. `event` is the name and the rest is flat
 * (`api_server_runs.py:64`), which is why this is a loose record rather than a
 * discriminated union: a future engine event must not fail the parse and lose
 * the frames around it.
 */
export const hermesRunEvent = z
  .object({
    event: z.string().min(1),
    run_id: z.string().optional(),
    timestamp: z.number().optional(),
  })
  .loose();
export type HermesRunEvent = z.infer<typeof hermesRunEvent>;

/** The engine's terminal frames. Anything else means the run is still going. */
export const HERMES_TERMINAL_EVENTS = [
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
] as const;

export const isTerminalEvent = (name: string): boolean =>
  (HERMES_TERMINAL_EVENTS as readonly string[]).includes(name);
