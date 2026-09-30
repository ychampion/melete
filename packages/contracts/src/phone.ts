/**
 * Phone calls, placed and taken through a phone line.
 *
 * A line is a `phone` connection: one number imported into ElevenLabs Agents,
 * whose agent answers every turn by asking Melete. The shapes here are what the
 * owner reads back about a call, and what ElevenLabs sends to the three routes
 * it calls: the turn endpoint, the start of an inbound call, and the end of any
 * call. Those three authenticate the line, not a person.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

export const PHONE_CALL_DIRECTIONS = ['outbound', 'inbound'] as const;
/** Who is on the other end: the person themself, the party an approved call reached, or a stranger. */
export const PHONE_CALL_PARTIES = ['person', 'other', 'unknown'] as const;
export const PHONE_CALL_STATUSES = ['dialing', 'in_progress', 'ended', 'failed'] as const;

export const phoneCallLine = z.strictObject({
  /** `melete` for what the assistant said, `caller` for the other end. */
  speaker: z.enum(['melete', 'caller']),
  text: z.string().max(10_000),
  /** Seconds from the start of the call, when ElevenLabs said. */
  at_seconds: z.number().nonnegative().nullable(),
});
export type PhoneCallLine = z.infer<typeof phoneCallLine>;

export const phoneCallView = z
  .strictObject({
    id: prefixedId(ID_PREFIXES.phone_call),
    connection_id: prefixedId(ID_PREFIXES.connection),
    job_id: prefixedId(ID_PREFIXES.job).nullable(),
    direction: z.enum(PHONE_CALL_DIRECTIONS),
    /** A phone call, or a WhatsApp chat or call on the line's WhatsApp number. */
    channel: z.enum(['phone', 'whatsapp']),
    party: z.enum(PHONE_CALL_PARTIES),
    remote_number: z.string(),
    /** Why an outbound call was placed, as approved. Empty for an inbound call. */
    purpose: z.string().nullable(),
    status: z.enum(PHONE_CALL_STATUSES),
    /** What came of the call, as the assistant recorded it or ElevenLabs summarised it. */
    outcome: z.string().nullable(),
    /** What the call asked for that needs doing afterwards; each is proposed, never done, on the call. */
    follow_ups: z.array(z.string()),
    transcript: z.array(phoneCallLine),
    duration_seconds: z.number().int().nonnegative().nullable(),
    /** Why a call did not connect, in plain words. */
    failure: z.string().nullable(),
    created_at: timestamp,
    ended_at: timestamp.nullable(),
  })
  .meta({ id: 'PhoneCall' });
export type PhoneCallView = z.infer<typeof phoneCallView>;
export const phoneCallResponse = z.object({ call: phoneCallView });

/**
 * One turn, as ElevenLabs asks for it: an OpenAI chat-completions request.
 * Only the fields Melete reads are named; the rest pass unread.
 */
export const phoneTurnRequest = z
  .looseObject({
    messages: z
      .array(
        z.looseObject({
          role: z.string(),
          content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
        }),
      )
      .max(2000),
    stream: z.boolean().optional(),
    tools: z.array(z.unknown()).optional(),
    /** What the call's start handed over; Melete puts its own call id here. */
    elevenlabs_extra_body: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'PhoneTurnRequest' });
export type PhoneTurnRequest = z.infer<typeof phoneTurnRequest>;

/** The start of an inbound call, sent before the first word is spoken. */
export const phoneInboundRequest = z
  .looseObject({
    caller_id: z.string().max(64).optional(),
    called_number: z.string().max(64).optional(),
    agent_id: z.string().max(200).optional(),
    call_sid: z.string().max(200).optional(),
    conversation_id: z.string().max(200).optional(),
  })
  .meta({ id: 'PhoneInboundRequest' });

/** What the call starts with: the opening line, and the call id every turn carries back. */
export const phoneInboundResponse = z
  .object({
    type: z.literal('conversation_initiation_client_data'),
    conversation_config_override: z.object({
      agent: z.object({ first_message: z.string() }),
    }),
    custom_llm_extra_body: z.object({ call_id: prefixedId(ID_PREFIXES.phone_call) }),
  })
  .meta({ id: 'PhoneInboundResponse' });

/** The end of a call, or a call that never connected. Signed with the line's webhook secret. */
export const phoneEventRequest = z
  .looseObject({
    type: z.string(),
    event_timestamp: z.number().optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'PhoneEvent' });
