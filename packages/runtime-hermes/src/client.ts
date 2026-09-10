/**
 * A typed client for the pinned Hermes release's HTTP surface. It builds
 * requests and parses responses; it never opens a socket, so the whole thing is
 * testable without a container.
 *
 * The five calls Melete uses:
 *   POST /v1/runs                  start one bounded attempt
 *   GET  /v1/runs/{id}             status
 *   GET  /v1/runs/{id}/events      the SSE stream, consumed exactly once
 *   POST /v1/runs/{id}/approval    answer a command-approval notification
 *   POST /v1/runs/{id}/stop        cancel
 */
import type { AttemptBundle } from '@melete/contracts';
import { z } from 'zod';

export const HERMES_ROUTES = {
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

export const hermesRunStatus = z.object({
  run_id: z.string(),
  status: z.enum(['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'stopped']),
  error: z.string().nullable().optional(),
});
export type HermesRunStatus = z.infer<typeof hermesRunStatus>;

export const hermesRunAccepted = z.object({
  run_id: z.string(),
  status: z.string(),
});
export type HermesRunAccepted = z.infer<typeof hermesRunAccepted>;

/**
 * What the gateway notifier sends when a command needs a decision. The probe
 * recorded these exact fields; `request_id` is what an answer is addressed to.
 */
export const hermesApprovalRequest = z.object({
  request_id: z.string(),
  command: z.string(),
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
  /** Surrogate token; the gateway swaps it for a real provider key. */
  token?: string;
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

  /**
   * Start a run from an attempt bundle. Everything thin about the harness is
   * expressed here: memory and context files off, no built-in toolsets, the
   * identity in place of SOUL.md, at most three skills.
   */
  startRun(bundle: AttemptBundle): HermesRequest {
    const body = {
      input: this.renderInput(bundle),
      system: this.renderSystem(bundle),
      // The plugin registers the broker's tools; nothing built in is available.
      skip_memory: true,
      skip_context_files: true,
      toolsets: [],
      metadata: {
        attempt_id: bundle.attempt.id,
        job_id: bundle.attempt.job_id,
        epoch: bundle.attempt.epoch,
        revision: bundle.attempt.revision,
      },
      max_turns: bundle.budget.max_turns,
      max_output_tokens: bundle.budget.max_output_tokens,
      provider: bundle.model.provider,
      model: bundle.model.model,
    };
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.runs}`,
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
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
   * The event stream. Melete consumes it once and persists before fan-out; an
   * interrupted run is a dead attempt, never resumed, so `lastEventId` exists
   * only to finish reading a stream that was already open.
   */
  events(runId: string, lastEventId?: string): HermesRequest {
    const extra: Record<string, string> = { accept: 'text/event-stream' };
    if (lastEventId) extra['last-event-id'] = lastEventId;
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.events(runId)}`,
      method: 'GET',
      headers: this.headers(extra),
    };
  }

  approve(runId: string, requestId: string, answer: HermesApprovalAnswer): HermesRequest {
    return {
      url: `${this.baseUrl}${HERMES_ROUTES.approval(runId)}`,
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ request_id: requestId, answer }),
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

  /** Stable prefix first, volatile inputs last, so the provider can cache it. */
  renderSystem(bundle: AttemptBundle): string {
    const parts = [IDENTITY];
    if (bundle.skills.length > 0) {
      parts.push(bundle.skills.map((s) => `## ${s.name}\n${s.body}`).join('\n\n'));
    }
    if (bundle.knowledge.length > 0) {
      parts.push(
        `## What Melete already knows\n${bundle.knowledge
          .map((k) => `- ${k.path}: ${k.excerpt}`)
          .join('\n')}`,
      );
    }
    return parts.join('\n\n');
  }

  renderInput(bundle: AttemptBundle): string {
    const lines = [`# ${bundle.job.title}`, bundle.job.objective];
    if (bundle.job.progress_summary) lines.push(`## So far\n${bundle.job.progress_summary}`);
    for (const message of bundle.inputs.new_user_messages) {
      lines.push(`## From the owner\n${message.content}`);
    }
    for (const approval of bundle.inputs.approval_results) {
      lines.push(`## Decision\n${approval.action_id} was ${approval.decision}.`);
    }
    return lines.join('\n\n');
  }
}

/** Under 250 tokens by contract; the runtime image ships it in place of SOUL.md. */
export const IDENTITY = `You are Melete, a personal assistant working on one responsibility at a time.
You cannot reach the network, the filesystem outside /work, or any account directly.
Every effect on the world goes through a tool call, and each one is recorded, may need the owner's approval, and may be refused.
Work in small steps. When you need a fact, search knowledge before guessing.
When you cannot proceed without the owner, ask exactly one precise question and stop.
When you finish, say what you did and point at the evidence.
Never claim you sent, saved, or scheduled something unless a tool call returned a receipt for it.`;

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
