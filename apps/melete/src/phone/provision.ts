/**
 * Setting a phone line up at ElevenLabs, and taking it down again.
 *
 * A line is four things there: a workspace secret holding the line's own key
 * (the key ElevenLabs presents to Melete on every turn and at the start of an
 * inbound call), a workspace webhook that reports the end of each call, an
 * agent whose language model is Melete, and the imported number assigned to
 * that agent. They are made in that order and removed in the reverse one, and
 * a line that fails part way is taken down before the failure is reported, so
 * nothing is left behind at ElevenLabs for a connection that does not exist.
 */
import type { PhoneConnectionConfig, PhoneCredentials } from '@melete/contracts';
import { type ElevenLabsClient, ElevenLabsError } from './elevenlabs.ts';

/** What ElevenLabs holds for a line, as the connection stores it. */
export type LineIds = {
  agent_id?: string;
  phone_number_id?: string;
  secret_id?: string;
  webhook_id?: string;
  /** The person's WhatsApp number, when the line answers it too. */
  whatsapp_phone_number_id?: string;
};

export type Provisioned = Required<Omit<LineIds, 'whatsapp_phone_number_id'>> &
  Pick<LineIds, 'whatsapp_phone_number_id'> & { webhook_secret: string };

/** The header ElevenLabs sends the line's key in, besides the bearer token. */
export const LINE_KEY_HEADER = 'x-melete-key';
/** A call may run this long before ElevenLabs ends it. */
export const MAX_CALL_SECONDS = 900;

/** The three addresses ElevenLabs calls for one line. */
export function lineAddresses(publicUrl: string, connectionId: string) {
  const base = `${publicUrl.replace(/\/+$/, '')}/phone/${connectionId}`;
  return { llm: `${base}/llm/v1`, inbound: `${base}/inbound`, events: `${base}/events` };
}

/**
 * The agent. Its prompt is a placeholder: every reply is written by Melete,
 * which ignores what the agent's own prompt says. The opening line is given
 * per call, the call id travels in the custom LLM's extra body, and an inbound
 * call asks Melete who is calling before its first word.
 */
export function agentBody(input: {
  name: string;
  llmUrl: string;
  inboundUrl: string;
  secretId: string;
  webhookId: string;
}): Record<string, unknown> {
  const key = { secret_id: input.secretId };
  return {
    name: input.name,
    conversation_config: {
      agent: {
        first_message: '',
        language: 'en',
        prompt: {
          prompt: 'Melete writes every reply on this line.',
          llm: 'custom-llm',
          custom_llm: {
            url: input.llmUrl,
            model_id: 'melete',
            api_key: key,
            request_headers: { [LINE_KEY_HEADER]: key },
          },
          built_in_tools: {
            end_call: { name: 'end_call', params: { system_tool_type: 'end_call' } },
          },
        },
      },
      conversation: { max_duration_seconds: MAX_CALL_SECONDS },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: { agent: { first_message: true } },
        custom_llm_extra_body: true,
        enable_conversation_initiation_client_data_from_webhook: true,
      },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: {
          url: input.inboundUrl,
          request_headers: { [LINE_KEY_HEADER]: key },
        },
        webhooks: {
          post_call_webhook_id: input.webhookId,
          events: ['transcript', 'call_initiation_failure'],
        },
      },
    },
  };
}

/** The number, imported from Twilio or a SIP trunk and assigned to the agent. */
export function numberBody(
  config: PhoneConnectionConfig,
  credentials: PhoneCredentials,
  label: string,
  agentId: string,
): Record<string, unknown> {
  if (config.telephony === 'twilio')
    return {
      provider: 'twilio',
      phone_number: config.number,
      label,
      sid: credentials.twilio_account_sid,
      token: credentials.twilio_auth_token,
      agent_id: agentId,
    };
  const sip = { username: credentials.sip_username, password: credentials.sip_password };
  return {
    provider: 'sip_trunk',
    phone_number: config.number,
    label,
    agent_id: agentId,
    inbound_trunk_config: { credentials: sip },
    outbound_trunk_config: {
      address: config.sip_address,
      transport: config.sip_transport ?? 'auto',
      credentials: sip,
    },
  };
}

/**
 * Make the line's four parts. On any failure, what was made is removed and the
 * failure is thrown again for `provisioningProblem` to put into words.
 */
export async function provisionLine(
  client: ElevenLabsClient,
  input: {
    connectionId: string;
    publicUrl: string;
    label: string;
    config: PhoneConnectionConfig;
    credentials: PhoneCredentials;
    lineKey: string;
  },
): Promise<Provisioned> {
  const addresses = lineAddresses(input.publicUrl, input.connectionId);
  const name = `Melete ${input.connectionId}`;
  const made: LineIds = {};
  try {
    made.secret_id = await client.createSecret(name, input.lineKey);
    const webhook = await client.createWebhook(name, addresses.events);
    made.webhook_id = webhook.webhook_id;
    made.agent_id = await client.createAgent(
      agentBody({
        name: `Melete (${input.label})`,
        llmUrl: addresses.llm,
        inboundUrl: addresses.inbound,
        secretId: made.secret_id,
        webhookId: made.webhook_id,
      }),
    );
    made.phone_number_id = await client.importNumber(
      numberBody(input.config, input.credentials, input.label, made.agent_id),
    );
    // The WhatsApp number was connected in ElevenLabs by the person; the line only answers it.
    const whatsapp = input.config.whatsapp?.phone_number_id;
    if (whatsapp) {
      await client.assignWhatsApp(whatsapp, made.agent_id);
      made.whatsapp_phone_number_id = whatsapp;
    }
    return {
      agent_id: made.agent_id,
      phone_number_id: made.phone_number_id,
      secret_id: made.secret_id,
      webhook_id: made.webhook_id,
      ...(whatsapp ? { whatsapp_phone_number_id: whatsapp } : {}),
      webhook_secret: webhook.webhook_secret,
    };
  } catch (error) {
    await teardownLine(client, made).catch(() => false);
    throw error;
  }
}

/**
 * Remove whatever of a line exists, number first and secret last, since a
 * secret an agent still uses cannot be deleted. Something already gone counts
 * as removed. True when every part is gone.
 */
export async function teardownLine(client: ElevenLabsClient, ids: LineIds): Promise<boolean> {
  let complete = true;
  const steps: Array<[string | undefined, (id: string) => Promise<void>]> = [
    // The WhatsApp number is the person's own; it is released from the agent, never deleted.
    [ids.whatsapp_phone_number_id, (id) => client.assignWhatsApp(id, null)],
    [ids.phone_number_id, (id) => client.deleteNumber(id)],
    [ids.agent_id, (id) => client.deleteAgent(id)],
    [ids.webhook_id, (id) => client.deleteWebhook(id)],
    [ids.secret_id, (id) => client.deleteSecret(id)],
  ];
  for (const [id, remove] of steps) {
    if (!id) continue;
    try {
      await remove(id);
    } catch {
      complete = false;
    }
  }
  return complete;
}

/** A provisioning failure, in words the person can act on. Nothing ElevenLabs wrote is repeated. */
export function provisioningProblem(error: unknown, telephony: 'twilio' | 'sip_trunk'): string {
  if (!(error instanceof ElevenLabsError))
    return 'The phone line could not be set up. Try again shortly.';
  if (error.status === null)
    return 'ElevenLabs could not be reached, so the phone line was not set up. Try again shortly.';
  if (error.status === 401)
    return 'ElevenLabs refused the API key. Check it, and that it may use Agents, then try again.';
  if (error.status === 403)
    return error.step === 'number' && telephony === 'sip_trunk'
      ? 'ElevenLabs would not import the SIP trunk number. SIP trunking needs an ElevenLabs Enterprise plan.'
      : 'The ElevenLabs API key does not have access to Agents. Give it that access and try again.';
  if (error.step === 'whatsapp')
    return error.status === 404 || error.status === 422
      ? 'ElevenLabs has no WhatsApp number with that phone number id. Connect the number in ElevenLabs under Agents, WhatsApp, and copy its id.'
      : 'ElevenLabs could not give the WhatsApp number to the line. Try again shortly.';
  if (error.step === 'number')
    return telephony === 'twilio'
      ? 'ElevenLabs could not import the number. Check the Twilio account SID, the auth token, and that the number belongs to that account.'
      : 'ElevenLabs could not import the number. Check the SIP trunk address, username and password.';
  if (error.status === 429)
    return 'ElevenLabs is limiting requests from this account. Try again in a few minutes.';
  return 'ElevenLabs could not set up the phone line. Nothing was left behind; try again shortly.';
}
