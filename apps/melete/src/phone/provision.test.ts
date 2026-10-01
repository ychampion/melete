import { describe, expect, test } from 'bun:test';
import type { PhoneConnectionConfig, PhoneCredentials } from '@melete/contracts';
import { ElevenLabsClient, ElevenLabsError, type Fetch } from './elevenlabs.ts';
import { provisioningProblem, provisionLine, teardownLine } from './provision.ts';

type Seen = { method: string; path: string; key: string | null; body: unknown };

/** A stand-in for ElevenLabs that records each request and answers from a table. */
function stubElevenLabs(
  answers: Record<string, (body: unknown) => { status: number; body?: unknown }> = {},
) {
  const seen: Seen[] = [];
  const fetcher: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    seen.push({
      method,
      path: url.pathname,
      key: new Headers(init?.headers).get('xi-api-key'),
      body,
    });
    const route = `${method} ${url.pathname}`;
    const answer =
      answers[route]?.(body) ??
      (route === 'POST /v1/convai/secrets'
        ? { status: 200, body: { type: 'stored', secret_id: 'sec_el', name: 'x' } }
        : route === 'POST /v1/workspace/webhooks'
          ? { status: 200, body: { webhook_id: 'wh_el', webhook_secret: 'whsec_el' } }
          : route === 'POST /v1/convai/agents/create'
            ? { status: 200, body: { agent_id: 'agent_el' } }
            : route === 'POST /v1/convai/phone-numbers'
              ? { status: 200, body: { phone_number_id: 'phnum_el' } }
              : { status: 200, body: {} });
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { seen, fetcher };
}

const twilio: PhoneConnectionConfig = {
  telephony: 'twilio',
  number: '+14155550100',
  on_behalf_of: 'Zara',
  allowed_callers: ['+14155550199'],
  daily_call_limit: 10,
  calling_hours_start: '09:00',
  calling_hours_end: '20:00',
};
const twilioCredentials: PhoneCredentials = {
  api_key: 'xi-key',
  twilio_account_sid: `AC${'a'.repeat(32)}`,
  twilio_auth_token: 'twilio-token',
};
const input = {
  connectionId: 'conn_01JABCDEFGHJKMNPQRSTVWXYZ0',
  publicUrl: 'https://melete.example.com/',
  label: 'Home line',
  config: twilio,
  credentials: twilioCredentials,
  lineKey: 'line-key-value',
};

describe('setting a phone line up at ElevenLabs', () => {
  test('a Twilio line makes the secret, the webhook, the agent and the number, in that order', async () => {
    const stub = stubElevenLabs();
    const made = await provisionLine(
      new ElevenLabsClient('xi-key', { base: 'https://api.elevenlabs.io', fetch: stub.fetcher }),
      input,
    );
    expect(made).toEqual({
      secret_id: 'sec_el',
      webhook_id: 'wh_el',
      agent_id: 'agent_el',
      phone_number_id: 'phnum_el',
      webhook_secret: 'whsec_el',
    });
    expect(stub.seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/convai/secrets',
      'POST /v1/workspace/webhooks',
      'POST /v1/convai/agents/create',
      'POST /v1/convai/phone-numbers',
    ]);
    expect(stub.seen.every((request) => request.key === 'xi-key')).toBe(true);
    const [secret, webhook, agent, number] = stub.seen.map((request) => request.body);
    expect(secret).toEqual({
      type: 'new',
      name: `Melete ${input.connectionId}`,
      value: 'line-key-value',
    });
    expect(webhook).toEqual({
      settings: {
        auth_type: 'hmac',
        name: `Melete ${input.connectionId}`,
        webhook_url: `https://melete.example.com/phone/${input.connectionId}/events`,
      },
    });
    expect(agent).toMatchObject({
      conversation_config: {
        agent: {
          prompt: {
            llm: 'custom-llm',
            custom_llm: {
              url: `https://melete.example.com/phone/${input.connectionId}/llm/v1`,
              api_key: { secret_id: 'sec_el' },
              request_headers: { 'x-melete-key': { secret_id: 'sec_el' } },
            },
            built_in_tools: {
              end_call: { name: 'end_call', params: { system_tool_type: 'end_call' } },
            },
          },
        },
      },
      platform_settings: {
        overrides: {
          conversation_config_override: { agent: { first_message: true } },
          custom_llm_extra_body: true,
          enable_conversation_initiation_client_data_from_webhook: true,
        },
        workspace_overrides: {
          conversation_initiation_client_data_webhook: {
            url: `https://melete.example.com/phone/${input.connectionId}/inbound`,
            request_headers: { 'x-melete-key': { secret_id: 'sec_el' } },
          },
          webhooks: { post_call_webhook_id: 'wh_el' },
        },
      },
    });
    // The line key reaches ElevenLabs only as the workspace secret, never in the agent itself.
    expect(JSON.stringify(agent)).not.toContain('line-key-value');
    expect(number).toEqual({
      provider: 'twilio',
      phone_number: '+14155550100',
      label: 'Home line',
      sid: twilioCredentials.twilio_account_sid,
      token: 'twilio-token',
      agent_id: 'agent_el',
    });
  });

  test('a SIP trunk line imports its number with the trunk address and credentials', async () => {
    const stub = stubElevenLabs();
    await provisionLine(new ElevenLabsClient('xi-key', { fetch: stub.fetcher }), {
      ...input,
      config: {
        ...twilio,
        telephony: 'sip_trunk',
        sip_address: 'sip.telnyx.com',
        sip_transport: 'tls',
      },
      credentials: { api_key: 'xi-key', sip_username: 'trunk-user', sip_password: 'trunk-pass' },
    });
    expect(stub.seen.at(-1)?.body).toEqual({
      provider: 'sip_trunk',
      phone_number: '+14155550100',
      label: 'Home line',
      agent_id: 'agent_el',
      inbound_trunk_config: { credentials: { username: 'trunk-user', password: 'trunk-pass' } },
      outbound_trunk_config: {
        address: 'sip.telnyx.com',
        transport: 'tls',
        credentials: { username: 'trunk-user', password: 'trunk-pass' },
      },
    });
  });

  test('a failure part way takes down what was made, number first and secret last', async () => {
    const stub = stubElevenLabs({
      'POST /v1/convai/phone-numbers': () => ({
        status: 422,
        body: { detail: 'bad sid, token=twilio-token' },
      }),
    });
    const error = await provisionLine(
      new ElevenLabsClient('xi-key', { fetch: stub.fetcher }),
      input,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect(stub.seen.slice(4).map((request) => `${request.method} ${request.path}`)).toEqual([
      'DELETE /v1/convai/agents/agent_el',
      'DELETE /v1/workspace/webhooks/wh_el',
      'DELETE /v1/convai/secrets/sec_el',
    ]);
    const words = provisioningProblem(error, 'twilio');
    expect(words).toContain('Twilio account SID');
    // Nothing ElevenLabs wrote comes back.
    expect(words).not.toContain('twilio-token');
    expect(words).not.toContain('bad sid');
  });

  test('each failure is told in words the person can act on', () => {
    expect(provisioningProblem(new ElevenLabsError('secret', 401), 'twilio')).toContain(
      'refused the API key',
    );
    expect(provisioningProblem(new ElevenLabsError('number', 403), 'sip_trunk')).toContain(
      'allow phone numbers',
    );
    expect(provisioningProblem(new ElevenLabsError('agent', null), 'twilio')).toContain(
      'could not be reached',
    );
    expect(provisioningProblem(new ElevenLabsError('number', 422), 'sip_trunk')).toContain(
      'SIP trunk address',
    );
    expect(provisioningProblem(new Error('x'), 'twilio')).toContain('could not be set up');
  });

  test('taking a line down counts a part already gone as removed', async () => {
    const stub = stubElevenLabs({
      'DELETE /v1/convai/agents/agent_el': () => ({ status: 404 }),
    });
    const complete = await teardownLine(new ElevenLabsClient('xi-key', { fetch: stub.fetcher }), {
      agent_id: 'agent_el',
      phone_number_id: 'phnum_el',
      secret_id: 'sec_el',
      webhook_id: 'wh_el',
    });
    expect(complete).toBe(true);
    expect(stub.seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      'DELETE /v1/convai/phone-numbers/phnum_el',
      'DELETE /v1/convai/agents/agent_el',
      'DELETE /v1/workspace/webhooks/wh_el',
      'DELETE /v1/convai/secrets/sec_el',
    ]);
    const failing = stubElevenLabs({ 'DELETE /v1/convai/secrets/sec_el': () => ({ status: 500 }) });
    expect(
      await teardownLine(new ElevenLabsClient('xi-key', { fetch: failing.fetcher }), {
        secret_id: 'sec_el',
      }),
    ).toBe(false);
  });
});
