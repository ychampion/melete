/**
 * How the agent sounds: the voice a person picks for its replies and drafts.
 *
 * `teammate` is how Melete has always talked: short, plain, contractions, like
 * a capable colleague in chat. `professional` is the same plain writing with a
 * more formal register, for a person who wants their assistant to sound like
 * one. Either way a draft is written for its reader: a message to a client,
 * a landlord or an office reads professional even in the teammate voice,
 * unless the person asks for something else.
 */
import { z } from 'zod';

export const REPLY_VOICES = ['teammate', 'professional'] as const;
export const replyVoice = z.enum(REPLY_VOICES);
export type ReplyVoice = z.infer<typeof replyVoice>;

/** The voice a person has until they pick one: the one Melete has always used. */
export const DEFAULT_REPLY_VOICE: ReplyVoice = 'teammate';

/** A stored voice, read leniently: anything unknown is the default. */
export function readReplyVoice(value: unknown): ReplyVoice {
  const parsed = replyVoice.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_REPLY_VOICE;
}
