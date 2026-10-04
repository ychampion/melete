/**
 * Sorting what came in, and what needs the person.
 *
 * New mail and calendar changes that the built-in rules cannot settle on their
 * own are read in small groups by a small model, which gives each one a label:
 * `needs_you`, `fyi` or `ignore`, with a short reason. Labels are all it gives.
 * It never makes anything urgent, starts work, sends anything or acts.
 *
 * Home's "Needs you" list is built from those labels and from what Melete
 * noticed on its own, ranked so the few things that need the person come first.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/** What the person should make of one item. */
export const TRIAGE_VERDICTS = ['needs_you', 'fyi', 'ignore'] as const;
export const triageVerdict = z.enum(TRIAGE_VERDICTS);
export type TriageVerdict = z.infer<typeof triageVerdict>;

/**
 * How soon. A label can say `soon` at most: only a deadline the person set
 * makes anything urgent, and sorting never does.
 */
export const TRIAGE_URGENCIES = ['normal', 'soon'] as const;
export const triageUrgency = z.enum(TRIAGE_URGENCIES);
export type TriageUrgency = z.infer<typeof triageUrgency>;

/** Where an item on the list came from, which decides the routes that acknowledge it. */
export const NEEDS_YOU_SOURCES = ['triage', 'situation'] as const;

/** What an item rests on: the message or calendar entry it was read from. */
export const needsYouBecause = z.strictObject({
  kind: z.enum(['mail', 'calendar', 'situation']),
  /** One line naming the source, such as "Email from Dana Kim". */
  label: z.string().max(400),
  /** The handle of the observation or record behind it: `event:<seq>`, `subject:<key>`. */
  handle: z.string().max(300),
  /** The message's subject or the meeting's title, as the source wrote it. Outside content. */
  subject: z.string().max(300).nullable(),
  /** When the message arrived, or when the meeting starts. */
  at: timestamp.nullable(),
});
export type NeedsYouBecause = z.infer<typeof needsYouBecause>;

export const needsYouItem = z.strictObject({
  /** A `tri_` id for a sorted item, a `sit_` id for something Melete noticed. */
  id: z.string().min(1).max(64),
  source: z.enum(NEEDS_YOU_SOURCES),
  /** One plain sentence: what needs the person. */
  sentence: z.string().max(400),
  /** Why, in a few words. */
  reason: z.string().max(400),
  because: needsYouBecause,
  urgency: z.enum(['normal', 'soon', 'urgent']),
  /** The person has seen it. */
  seen: z.boolean(),
  created_at: timestamp,
  /**
   * What starting a chat about it says in the person's name: a reference to the
   * source and nothing from it. The source itself comes with the chat as an
   * attached file (`POST /needs-you/{id}/source`), read as untrusted data. The
   * chat is an ordinary one: anything it would do still asks first.
   */
  chat_prompt: z.string().max(1000).nullable(),
});
export type NeedsYouItem = z.infer<typeof needsYouItem>;

export const needsYouList = z.strictObject({
  items: z.array(needsYouItem),
  /** Items from the last week not sorted yet: kept private, over a limit, or a failed call. */
  unsorted: z.number().int().nonnegative(),
  /**
   * The main reason, when some are waiting: `kept_private` (a private space with
   * no local model), `limit_reached` (a background spending limit), `failed` (the
   * model could not be reached or did not answer), `off` (sorting is turned off).
   */
  unsorted_reason: z.enum(['kept_private', 'limit_reached', 'failed', 'off']).nullable(),
});
export type NeedsYouList = z.infer<typeof needsYouList>;

export const needsYouItemResponse = z.strictObject({ item: needsYouItem });

export const triageItemId = prefixedId(ID_PREFIXES.triage_item);
