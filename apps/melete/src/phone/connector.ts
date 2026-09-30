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

export const phoneManifest: ConnectorManifest = {
  name: 'phone',
  version: '0.1.0',
  provider: 'phone',
  description: 'Place a phone call for the person, after they approve who is called and why.',
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
      description:
        'Call a phone number for the person. The approval covers the number, the purpose, what may be shared and what must not be agreed to. On the call Melete says it is an AI assistant, shares only what is allowed, agrees to nothing, and reports back afterwards.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['phone_number', 'purpose', 'may_share', 'must_not_agree_to'],
        properties: {
          phone_number: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' },
          purpose: { type: 'string', minLength: 1, maxLength: 500 },
          may_share: { type: 'string', maxLength: 1000 },
          must_not_agree_to: { type: 'string', maxLength: 1000 },
          callee_name: { type: 'string', maxLength: 80 },
          callee_time_zone: {
            type: 'string',
            maxLength: 64,
            description:
              'The callee’s time zone, such as Europe/London, when the number alone does not say.',
          },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['phone.call'],
      verify: true,
      requires_approval: true,
    },
  ],
};

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

  return {
    manifest: phoneManifest,
    catalog: { audience: 'owner' },

    async execute(action): Promise<DispatchResult> {
      const parsed = phoneCallPayload.safeParse(action.canonical_payload);
      if (!parsed.success) return failed('The call request is not one this line can place.');
      const payload = parsed.data;
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
            (id, connection_id, space_id, job_id, attempt_id, action_id, direction, party,
             remote_number, context, status)
          values (${callId}, ${line.id}, ${line.spaceId}, ${action.job_id}, ${action.attempt_id},
            ${action.id}, 'outbound', 'other', ${payload.phone_number},
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
          `This line has placed its ${config.daily_call_limit} calls for today. Try again tomorrow, or raise the limit on the connection.`,
        );
      const notPlaced = async (reason: string) => {
        await sql`update phone_call set status = 'failed', failure = ${reason}, ended_at = now()
          where id = ${callId}`;
        return failed(reason);
      };
      let placed: Awaited<ReturnType<ElevenLabsClient['outboundCall']>>;
      try {
        placed = await withClient((api) =>
          api.outboundCall(config.telephony, {
            agentId: ids.agent_id,
            phoneNumberId: ids.phone_number_id,
            to: payload.phone_number,
            initiation: {
              conversation_config_override: {
                agent: { first_message: outboundOpening(config.on_behalf_of, payload.callee_name) },
              },
              custom_llm_extra_body: { call_id: callId },
            },
          }),
        );
      } catch (error) {
        // A refusal said nothing was placed. Silence, or a server failure, might have placed it.
        if (error instanceof ElevenLabsError && error.status !== null && error.status < 500)
          return notPlaced(
            error.status === 401
              ? 'ElevenLabs refused the line’s API key, so the call was not placed. Reconnect the phone line.'
              : 'ElevenLabs did not place the call.',
          );
        if (!(error instanceof ElevenLabsError))
          return notPlaced(
            'The phone line could not use its credentials, so the call was not placed.',
          );
        return {
          outcome: 'unknown',
          reason: 'ElevenLabs did not say whether the call was placed.',
        };
      }
      if (!placed.success || !placed.conversationId)
        return notPlaced('ElevenLabs did not place the call.');
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
