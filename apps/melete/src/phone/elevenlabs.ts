/**
 * The ElevenLabs Agents API, as far as a phone line uses it.
 *
 * Every request carries the line's own API key in `xi-api-key` and goes to one
 * HTTPS base the operator may point at a regional residency server. Nothing
 * ElevenLabs says in an error body crosses back: a failure is the step that
 * failed and its status, and the caller turns that into plain words.
 *
 * Shapes follow https://elevenlabs.io/docs/api-reference (agents, workspace
 * secrets and webhooks, phone numbers, outbound calls, conversations).
 */
import { z } from 'zod';

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const ELEVENLABS_API_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 20_000;

/** Which request failed, and what ElevenLabs answered (null when nothing came back). */
export class ElevenLabsError extends Error {
  constructor(
    readonly step: ElevenLabsStep,
    readonly status: number | null,
  ) {
    super(`ElevenLabs ${step} failed${status === null ? '' : ` with ${status}`}`);
  }
}

export type ElevenLabsStep =
  | 'secret'
  | 'webhook'
  | 'agent'
  | 'number'
  | 'call'
  | 'conversation'
  | 'whatsapp';

const secretCreated = z.object({ secret_id: z.string().min(1) });
const webhookCreated = z.object({
  webhook_id: z.string().min(1),
  webhook_secret: z.string().min(1),
});
const agentCreated = z.object({ agent_id: z.string().min(1) });
const numberCreated = z.object({ phone_number_id: z.string().min(1) });
const callPlaced = z.looseObject({
  success: z.boolean(),
  conversation_id: z.string().nullable().optional(),
  callSid: z.string().nullable().optional(),
  sip_call_id: z.string().nullable().optional(),
});
const transcriptEntry = z.looseObject({
  role: z.string(),
  message: z.string().nullable().optional(),
  time_in_call_secs: z.number().nullable().optional(),
});
export const conversationRecord = z.looseObject({
  conversation_id: z.string().optional(),
  agent_id: z.string().optional(),
  status: z.string().optional(),
  transcript: z.array(transcriptEntry).optional(),
  metadata: z
    .looseObject({
      call_duration_secs: z.number().nullable().optional(),
      termination_reason: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  analysis: z
    .looseObject({
      call_successful: z.string().nullable().optional(),
      transcript_summary: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  conversation_initiation_client_data: z
    .looseObject({ custom_llm_extra_body: z.record(z.string(), z.unknown()).nullable().optional() })
    .nullable()
    .optional(),
});
export type ConversationRecord = z.infer<typeof conversationRecord>;

export type OutboundCall = {
  agentId: string;
  phoneNumberId: string;
  to: string;
  /** Sent as `conversation_initiation_client_data`. */
  initiation: Record<string, unknown>;
};

export class ElevenLabsClient {
  private readonly base: string;
  private readonly fetcher: Fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: { base?: string; fetch?: Fetch; timeoutMs?: number } = {},
  ) {
    this.base = (options.base ?? ELEVENLABS_API_URL).replace(/\/+$/, '');
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * One request. `gone` lists statuses that mean the thing is already absent,
   * which a teardown counts as done.
   */
  private async request(
    step: ElevenLabsStep,
    method: string,
    path: string,
    body?: unknown,
    gone: number[] = [],
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          'xi-api-key': this.apiKey,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ElevenLabsError(step, null);
    }
    if (gone.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ElevenLabsError(step, response.status);
    }
    const text = await response.text().catch(() => '');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ElevenLabsError(step, response.status);
    }
  }

  private async parsed<T>(
    schema: z.ZodType<T>,
    step: ElevenLabsStep,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const result = schema.safeParse(await this.request(step, method, path, body));
    if (!result.success) throw new ElevenLabsError(step, 200);
    return result.data;
  }

  async createSecret(name: string, value: string): Promise<string> {
    return (
      await this.parsed(secretCreated, 'secret', 'POST', '/v1/convai/secrets', {
        type: 'new',
        name,
        value,
      })
    ).secret_id;
  }

  async deleteSecret(id: string): Promise<void> {
    await this.request(
      'secret',
      'DELETE',
      `/v1/convai/secrets/${encodeURIComponent(id)}`,
      undefined,
      [404],
    );
  }

  /** A workspace webhook signed with HMAC; the secret is returned once, here. */
  async createWebhook(name: string, url: string) {
    return this.parsed(webhookCreated, 'webhook', 'POST', '/v1/workspace/webhooks', {
      settings: { auth_type: 'hmac', name, webhook_url: url },
    });
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request(
      'webhook',
      'DELETE',
      `/v1/workspace/webhooks/${encodeURIComponent(id)}`,
      undefined,
      [404],
    );
  }

  async createAgent(body: Record<string, unknown>): Promise<string> {
    return (await this.parsed(agentCreated, 'agent', 'POST', '/v1/convai/agents/create', body))
      .agent_id;
  }

  async getAgent(id: string): Promise<'ok' | 'missing'> {
    const found = await this.request(
      'agent',
      'GET',
      `/v1/convai/agents/${encodeURIComponent(id)}`,
      undefined,
      [404],
    );
    return found === null ? 'missing' : 'ok';
  }

  async deleteAgent(id: string): Promise<void> {
    await this.request(
      'agent',
      'DELETE',
      `/v1/convai/agents/${encodeURIComponent(id)}`,
      undefined,
      [404],
    );
  }

  /** Import a number; `agent_id` assigns the agent to it in the same request. */
  async importNumber(body: Record<string, unknown>): Promise<string> {
    return (await this.parsed(numberCreated, 'number', 'POST', '/v1/convai/phone-numbers', body))
      .phone_number_id;
  }

  async deleteNumber(id: string): Promise<void> {
    await this.request(
      'number',
      'DELETE',
      `/v1/convai/phone-numbers/${encodeURIComponent(id)}`,
      undefined,
      [404],
    );
  }

  /** Place a call through a Twilio number or a SIP trunk. */
  async outboundCall(telephony: 'twilio' | 'sip_trunk', call: OutboundCall) {
    const placed = await this.parsed(
      callPlaced,
      'call',
      'POST',
      telephony === 'twilio'
        ? '/v1/convai/twilio/outbound-call'
        : '/v1/convai/sip-trunk/outbound-call',
      {
        agent_id: call.agentId,
        agent_phone_number_id: call.phoneNumberId,
        to_number: call.to,
        conversation_initiation_client_data: call.initiation,
      },
    );
    return {
      success: placed.success,
      conversationId: placed.conversation_id ?? null,
      providerCallId: placed.callSid ?? placed.sip_call_id ?? null,
    };
  }

  async getConversation(id: string): Promise<ConversationRecord> {
    return this.parsed(
      conversationRecord,
      'conversation',
      'GET',
      `/v1/convai/conversations/${encodeURIComponent(id)}`,
    );
  }
}
