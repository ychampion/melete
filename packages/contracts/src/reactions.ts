/**
 * Reactions.
 *
 * Not every message deserves a paragraph back. A person who reads a result and
 * is satisfied wants to say so in one tap, and an assistant that has been told
 * "thanks, got it" should be able to answer with an acknowledgement rather than
 * inventing three sentences of its own.
 *
 * A reaction is an event like any other: persisted before it is streamed,
 * replayed from the database on reconnect, and carried on the same SSE stream
 * the transcript already uses. It is drawn on the message bubble it belongs to,
 * never as a row of its own, because a system line saying "the owner reacted"
 * is exactly the noise a reaction exists to avoid.
 *
 * Reactions from a person also feed the attention counters: a thumbs-down says
 * the result was read and was not what was wanted, which is worse than unread,
 * and a thumbs-up says the streak is over.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/**
 * A message's identity is the `seq` of the event that carries it, as a decimal
 * string. Melete has no separate message table: the durable event stream is the
 * transcript, and a bubble on screen is one event. Using the seq means a client
 * that can render a message can already address it, and a reaction survives
 * exactly as long as the message does.
 */
export const messageId = z.string().regex(/^[1-9][0-9]{0,17}$/, 'must be an event seq');
export type MessageId = z.infer<typeof messageId>;

/** Who reacted. Both directions are first class; neither is a special case. */
export const reactionBy = z.enum(['person', 'assistant']);
export type ReactionBy = z.infer<typeof reactionBy>;

/**
 * One or more pictographic characters, with the joiners and skin-tone modifiers
 * that make a single glyph. Anything else, a word, a tag, a bare colon-code, is
 * refused: a reaction is a glyph, and a text reply is a message.
 */
export const reactionEmoji = z
  .string()
  .min(1)
  .max(24)
  .refine(
    (value) =>
      /^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u.test(value) &&
      /\p{Extended_Pictographic}/u.test(value),
    'must be one emoji',
  );

/** The two glyphs the attention rule reads. Everything else is expression only. */
export const THUMBS_UP = '\u{1F44D}';
export const THUMBS_DOWN = '\u{1F44E}';

/**
 * How much a reaction moves the attention counters. A thumbs-down means the
 * person read the result and it was wrong for them, which is a stronger signal
 * than silence, so the result it lands on counts as two unread ones and the
 * frequency reduction arrives sooner. A thumbs-up clears the streak outright,
 * the same as opening the job and reading it.
 */
export const UNREAD_WEIGHT_OF_THUMBS_DOWN = 2;

export const reaction = z.object({
  /** The event seq of the message this is drawn on. */
  message_id: messageId,
  emoji: reactionEmoji,
  by: reactionBy,
  /** The job whose stream carries it; null for a message outside any job. */
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  /** The seq of the reaction event itself, so a client can order them. */
  seq: z.number().int().positive(),
  created_at: timestamp,
});
export type Reaction = z.infer<typeof reaction>;

/**
 * What a client posts. `by` defaults to `person` because the API surface is the
 * person's; the runtime reaches the same behaviour through the broker's `react`
 * tool and never through this route.
 */
export const createReactionRequest = z.object({
  emoji: reactionEmoji,
  by: reactionBy.default('person'),
});
export type CreateReactionRequest = z.infer<typeof createReactionRequest>;

/** Public callers supply only the glyph; the authenticated route assigns identity. */
export const personReactionRequest = z.strictObject({ emoji: reactionEmoji });
export type PersonReactionRequest = z.infer<typeof personReactionRequest>;

export const reactionResponse = z.object({ reaction });
export const reactionListResponse = z.object({ reactions: z.array(reaction) });
export type ReactionListResponse = z.infer<typeof reactionListResponse>;

/**
 * What the runtime sends the broker when it answers with a glyph instead of
 * prose. No attempt input shows an event seq, so the target is optional: left
 * out, the broker reacts to the owner's latest message on this job.
 */
export const reactRequest = z.object({
  message_id: messageId.optional(),
  emoji: reactionEmoji,
});
export type ReactRequest = z.infer<typeof reactRequest>;

/**
 * The `react` tool as the catalog shows it. It changes nothing outside this
 * installation, so its effect class is `read` and it needs no approval; it
 * belongs to no connection, so its `connection_id` is null.
 */
export const REACT_TOOL_NAME = 'react';
export const reactToolSchema = {
  type: 'object',
  properties: {
    emoji: { type: 'string', description: 'One emoji.' },
    message_id: {
      type: 'string',
      description: "Optional. Leave it out to react to the owner's latest message.",
    },
  },
  required: ['emoji'],
  additionalProperties: false,
} as const;

/**
 * The reaction the attention counters read out of an event payload, or null
 * when the payload is not a person's reaction. Written as a function so the
 * service and its tests agree on what counts.
 */
export function attentionWeightOfReaction(
  emoji: string,
  by: ReactionBy,
): 'clear' | 'double' | null {
  if (by !== 'person') return null;
  if (emoji === THUMBS_UP) return 'clear';
  if (emoji === THUMBS_DOWN) return 'double';
  return null;
}
