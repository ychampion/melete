/**
 * The phone line as a connector: one tool, `phone.call`.
 *
 * A call is an external effect with an approval bound to its payload: the
 * number, why the call is made, what Melete may share and what it must not
 * agree to. Change any of them and the approval no longer covers it. When the
 * approved action is dispatched, the call is checked against the callee's
 * local calling hours and the line's daily limit, written down as `dialing`
 * under the action, and only then placed through ElevenLabs with the call id
 * in the conversation's initiation data. The opening line is fixed: it says an
 * AI assistant is calling, and for whom.
 */
import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  VerifyResult,
} from '@melete/contracts';
import { e164Number } from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { SecretAccess } from '../connectors/secrets.ts';
import type { Connector } from '../connectors/types.ts';
import { newId } from '../ids.ts';
import { outboundOpening } from './calls.ts';
import { ElevenLabsClient, ElevenLabsError, type Fetch } from './elevenlabs.ts';
import { withinHours, zonesFor } from './hours.ts';
import { type Line, withLineSecret } from './line.ts';
import { teardownLine } from './provision.ts';
import type { CallRow } from './turns.ts';

export const phoneCallPayload = z
  .object({
    phone_number: e164Number,
    purpose: z.string().trim().min(1).max(500),
    may_share: z.string().max(1000),
    must_not_agree_to: z.string().max(1000),
    callee_name: z.string().max(80).optional(),
    callee_time_zone: z.string().max(64).optional(),
  })
  .strict();
export type PhoneCallPayload = z.infer<typeof phoneCallPayload>;

/** A WhatsApp chat starts from the approved template, filled in with these values in order. */
export const whatsappMessagePayload = phoneCallPayload.extend({
  template_values: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
});

const contactProperties = {
  phone_number: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' },
  purpose: { type: 'string', minLength: 1, maxLength: 500 },
  may_share: { type: 'string', maxLength: 1000 },
  must_not_agree_to: { type: 'string', maxLength: 1000 },
  callee_name: { type: 'string', maxLength: 80 },
  callee_time_zone: {
    type: 'string',
    maxLength: 64,
    description:
      'The time zone of the person being contacted, such as Europe/London, when the number alone does not say.',
  },
};
const contactRequired = ['phone_number', 'purpose', 'may_share', 'must_not_agree_to'];
const APPROVAL =
  'The approval covers the number, the purpose, what may be shared and what must not be agreed to.';

/** The tools a line offers: a phone call always, WhatsApp with its number and templates. */
export function phoneManifest(config: Line['stored']['phone']): ConnectorManifest {
  const whatsapp = config.whatsapp;
  return {
    name: 'phone',
    version: '0.1.0',
    provider: 'phone',
    description:
      'Place a phone call, or start a WhatsApp chat or call, for the person, after they approve who is contacted and why.',
    credentials: [
      {
        key: 'elevenlabs',
        description: 'ElevenLabs API key and telephony credentials, sealed in the service.',
        secret: true,
      },
    ],
    health: true,
    tools: [
      {
        name: 'phone.call',
        description: `Call a phone number for the person. ${APPROVAL} On the call Melete says it is an AI assistant, shares only what is allowed, agrees to nothing, and reports back afterwards.`,
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: contactRequired,
          properties: contactProperties,
        },
        effect_class: 'write_external',
        required_scopes: ['phone.call'],
        verify: true,
        requires_approval: true,
      },
      ...(whatsapp?.message_template
        ? [
            {
              name: 'whatsapp.message',
              description: `Start a WhatsApp chat with someone for the person, from the approved template, and carry it on as their assistant. ${APPROVAL} Replies are answered within those limits, and the outcome is reported afterwards.`,
              input_schema: {
                type: 'object',
                additionalProperties: false,
                required: contactRequired,
                properties: {
                  ...contactProperties,
                  template_values: {
                    type: 'array',
                    maxItems: 10,
                    items: { type: 'string', minLength: 1, maxLength: 200 },
                    description: `The values the template "${whatsapp.message_template}" is filled in with, in order.`,
                  },
                },
              },
              effect_class: 'write_external' as const,
              required_scopes: ['whatsapp.message'],
              verify: true,
              requires_approval: true,
            },
          ]
        : []),
      ...(whatsapp?.call_template
        ? [
            {
              name: 'whatsapp.call',
              description: `Call someone on WhatsApp for the person. Someone who has not allowed calls from this number is first asked with the approved template. ${APPROVAL}`,
              input_schema: {
                type: 'object',
                additionalProperties: false,
                required: contactRequired,
                properties: contactProperties,
              },
              effect_class: 'write_external' as const,
              required_scopes: ['whatsapp.call'],
              verify: true,
              requires_approval: true,
            },
          ]
        : []),
    ],
  };
}

/** Lines taken down already in this process, so a revocation does it once. */
const takenDown = new Set<string>();

export type PhoneConnectorOptions = {
  line: Line;
  sql: Sql;
  secrets: SecretAccess;
  apiBase?: string;
  fetch?: Fetch;
  now?: () => Date;
};

export function createPhoneConnector(options: PhoneConnectorOptions): Connector {
  const { line, sql, secrets } = options;
  const config = line.stored.phone;
  const ids = line.stored.elevenlabs;
  const now = options.now ?? (() => new Date());
  const client = (apiKey: string) =>
    new ElevenLabsClient(apiKey, {
      ...(options.apiBase ? { base: options.apiBase } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  /**
   * The key is read from the row on every call, so a revoked line holds none;
   * taking it down afterwards reads the record the configuration points at.
   */
  const withClient = async <T>(use: (api: ElevenLabsClient) => Promise<T>) => {
    const [current] = await sql`select status, secret_ref from connection where id = ${line.id}`;
    if (!current?.secret_ref || current.status === 'revoked')
      throw new Error('this phone line no longer holds its credentials');
    return withLineSecret(
      secrets,
      { ...line, secretRef: current?.secret_ref ? String(current.secret_ref) : null },
      (credentials) => use(client(credentials.api_key)),
    );
  };
  const receipt = (action: Action, call: Pick<CallRow, 'id' | 'conversation_id'>) => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: call.conversation_id,
    detail: { call_id: call.id, placed: true },
    received_at: now().toISOString(),
    late: false,
  });
  const failed = (reason: string): DispatchResult => ({
    outcome: 'failed',
    reason,
    retryable: false,
  });

  const manifest = phoneManifest(config);
  return {
    manifest,
    catalog: { audience: 'owner' },

    async execute(action): Promise<DispatchResult> {
      const kind = action.kind as 'phone.call' | 'whatsapp.message' | 'whatsapp.call';
      const whatsapp = config.whatsapp;
      const template =
        kind === 'whatsapp.message'
          ? whatsapp?.message_template
          : kind === 'whatsapp.call'
            ? whatsapp?.call_template
            : undefined;
      if (
        !manifest.tools.some((tool) => tool.name === kind) ||
        (kind !== 'phone.call' && !template)
      )
        return failed('This line does not offer that.');
      const parsed = whatsappMessagePayload.safeParse(action.canonical_payload);
      if (!parsed.success || (kind !== 'whatsapp.message' && parsed.data.template_values))
        return failed('The request is not one this line can carry out.');
      const payload = parsed.data;
      const channel = kind === 'phone.call' ? 'phone' : 'whatsapp';
      const done = kind === 'whatsapp.message' ? 'send the message' : 'place the call';
      const undone =
        kind === 'whatsapp.message' ? 'the message was not sent' : 'the call was not placed';
      // One action places one call, however often it is dispatched.
      const [existing] = await sql<
        CallRow[]
      >`select * from phone_call where action_id = ${action.id}`;
      if (existing) {
        if (existing.conversation_id)
          return { outcome: 'succeeded', receipt: receipt(action, existing) };
        if (existing.status === 'failed')
          return failed(existing.failure ?? 'The call was not placed.');
        return { outcome: 'unknown', reason: 'An earlier dispatch of this call never heard back.' };
      }
      const zones = zonesFor(payload.phone_number, payload.callee_time_zone);
      if (!zones)
        return failed(
          `Melete cannot tell the local time for ${payload.phone_number}. Give the callee's time zone, such as Europe/London, and ask again.`,
        );
      if (!withinHours(zones, config.calling_hours_start, config.calling_hours_end, now()))
        return failed(
          `It is outside calling hours (${config.calling_hours_start} to ${config.calling_hours_end}) where ${payload.phone_number} is. Ask again within those hours.`,
        );
      const callId = newId('call');
      const admitted = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`phone-calls:${line.id}`}))`;
        // A call ElevenLabs refused to place is not a call; everything else counts.
        const [used] = await tx`select count(*)::int as calls from phone_call
          where connection_id = ${line.id} and direction = 'outbound'
            and created_at > now() - interval '1 day'
            and not (status = 'failed' and conversation_id is null)`;
        if (Number(used?.calls ?? 0) >= config.daily_call_limit) return false;
        await tx`insert into phone_call
            (id, connection_id, space_id, job_id, attempt_id, action_id, direction, channel, party,
             remote_number, context, status)
          values (${callId}, ${line.id}, ${line.spaceId}, ${action.job_id}, ${action.attempt_id},
            ${action.id}, 'outbound', ${channel}, 'other', ${payload.phone_number},
            ${JSON.stringify({
              purpose: payload.purpose,
              may_share: payload.may_share,
              must_not_agree_to: payload.must_not_agree_to,
              ...(payload.callee_name ? { callee_name: payload.callee_name } : {}),
            })}::jsonb, 'dialing')`;
        return true;
      });
      if (!admitted)
        return failed(
          `This line has reached ${config.daily_call_limit} calls and chats for today. Try again tomorrow, or raise the limit on the connection.`,
        );
      const notPlaced = async (reason: string) => {
        await sql`update phone_call set status = 'failed', failure = ${reason}, ended_at = now()
          where id = ${callId}`;
        return failed(reason);
      };
      // The opening is fixed; a chat opens with its approved template instead.
      const opening = {
        conversation_config_override: {
          agent: { first_message: outboundOpening(config.on_behalf_of, payload.callee_name) },
        },
      };
      const carried = { custom_llm_extra_body: { call_id: callId } };
      const userId = payload.phone_number.slice(1);
      let placed: { success: boolean; conversationId: string | null };
      try {
        placed = await withClient((api) =>
          kind === 'phone.call'
            ? api.outboundCall(config.telephony, {
                agentId: ids.agent_id,
                phoneNumberId: ids.phone_number_id,
                to: payload.phone_number,
                initiation: { ...opening, ...carried },
              })
            : kind === 'whatsapp.message'
              ? api.whatsappMessage({
                  phoneNumberId: whatsapp?.phone_number_id ?? '',
                  userId,
                  template: template ?? '',
                  language: whatsapp?.template_language ?? 'en',
                  values: payload.template_values ?? [],
                  agentId: ids.agent_id,
                  initiation: carried,
                })
              : api.whatsappCall({
                  phoneNumberId: whatsapp?.phone_number_id ?? '',
                  userId,
                  template: template ?? '',
                  language: whatsapp?.template_language ?? 'en',
                  agentId: ids.agent_id,
                  initiation: { ...opening, ...carried },
                }),
        );
      } catch (error) {
        // A refusal said nothing was placed. Silence, or a server failure, might have placed it.
        if (error instanceof ElevenLabsError && error.status !== null && error.status < 500)
          return notPlaced(
            error.status === 401
              ? `ElevenLabs refused the line’s API key, so ${undone}. Reconnect the phone line.`
              : `ElevenLabs did not ${done}.`,
          );
        if (!(error instanceof ElevenLabsError))
          return notPlaced(`The phone line could not use its credentials, so ${undone}.`);
        return {
          outcome: 'unknown',
          reason: `ElevenLabs did not say whether it could ${done}.`,
        };
      }
      if (!placed.success || !placed.conversationId)
        return notPlaced(`ElevenLabs did not ${done}.`);
      await sql`update phone_call set conversation_id = ${placed.conversationId},
          status = case when status = 'dialing' then 'in_progress' else status end
        where id = ${callId}`;
      return {
        outcome: 'succeeded',
        receipt: receipt(action, { id: callId, conversation_id: placed.conversationId }),
      };
    },

    async verify(action): Promise<VerifyResult> {
      const [call] = await sql<CallRow[]>`select * from phone_call where action_id = ${action.id}`;
      if (!call) return { decision: 'failed', evidence: { placed: false } };
      if (call.conversation_id)
        return {
          decision: 'succeeded',
          evidence: { call_id: call.id, conversation_id: call.conversation_id },
          receipt: receipt(action, call),
        };
      if (call.status === 'failed') return { decision: 'failed', evidence: { call_id: call.id } };
      return {
        decision: 'undecided',
        reason: 'ElevenLabs never said whether the call was placed.',
      };
    },

    async health(): Promise<ConnectorHealth> {
      const checked_at = now().toISOString();
      try {
        const found = await withClient((api) => api.getAgent(ids.agent_id));
        return found === 'ok'
          ? { status: 'ok', detail: 'The ElevenLabs agent answered.', checked_at }
          : { status: 'failing', detail: 'The ElevenLabs agent is gone.', checked_at };
      } catch (error) {
        return {
          status: 'failing',
          detail: 'ElevenLabs did not answer.',
          checked_at,
          ...(error instanceof ElevenLabsError && error.status === 401
            ? { reason: 'credential_refused' as const }
            : {}),
        };
      }
    },

    async retire() {
      await takeDown(line, sql, secrets, options);
    },
  };
}

/**
 * Remove a line's parts at ElevenLabs. It runs when the connection is revoked
 * or its space removed, whether or not a connector was serving it, and once.
 * A failure is reported without the line's details and leaves the connection
 * revoked all the same: ElevenLabs then holds an agent nothing answers for.
 */
export async function takeDown(
  line: Line,
  sql: Sql,
  secrets: SecretAccess,
  options: { apiBase?: string; fetch?: Fetch } = {},
): Promise<boolean> {
  if (takenDown.has(line.id)) return true;
  takenDown.add(line.id);
  const [current] = await sql`select secret_ref from connection where id = ${line.id}`;
  try {
    const complete = await withLineSecret(
      secrets,
      { ...line, secretRef: current?.secret_ref ? String(current.secret_ref) : null },
      (credentials) =>
        teardownLine(
          new ElevenLabsClient(credentials.api_key, {
            ...(options.apiBase ? { base: options.apiBase } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
          line.stored.elevenlabs,
        ),
    );
    if (!complete) {
      takenDown.delete(line.id);
      process.stderr.write('a phone line could not be fully removed at ElevenLabs\n');
    }
    return complete;
  } catch {
    takenDown.delete(line.id);
    process.stderr.write('a phone line could not be removed at ElevenLabs\n');
    return false;
  }
}
