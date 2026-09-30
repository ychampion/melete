/**
 * What Melete believes about a person, in words they can read and act on.
 *
 * A belief is a saved detail seen from the person's side: grouped by what it is
 * about, with where it came from in plain words, how far it can be trusted, and
 * its earlier versions. Correcting one records the person's own words and keeps
 * the history; forgetting one erases it; blocking one also stops Melete from
 * learning it again. A day of learning can be rewound as one operation, and a
 * rewind can itself be undone.
 */
import { z } from 'zod';

const id = z.string().min(1).max(240);
const text = z.string().min(1).max(4000);
const date = z.iso.datetime({ offset: true });
const day = z.iso.date();
const count = z.number().int().nonnegative();
const value = z.string().max(16000);

export const BELIEF_CATEGORIES = [
  'people',
  'preferences',
  'accounts',
  'routines',
  'work',
  'other',
] as const;
export const beliefCategory = z.enum(BELIEF_CATEGORIES);
export type BeliefCategory = z.infer<typeof beliefCategory>;

/**
 * How far a belief can be trusted, from its weakest source: the person's own
 * words, a connected account's record, content that came from someone else, or
 * something Melete worked out.
 */
export const beliefTrust = z.enum(['yours', 'connected', 'outside', 'worked_out']);
export type BeliefTrust = z.infer<typeof beliefTrust>;

/** Where the belief can be checked: the conversation it was said in, or a receipt. */
export const beliefLink = z.strictObject({
  kind: z.enum(['conversation', 'receipt']),
  id,
  label: text,
});
export const BELIEF_SOURCE_KINDS = [
  'setup',
  'chat',
  'correction',
  'import',
  'email',
  'calendar',
  'contacts',
  'connected',
  'receipt',
  'message',
  'document',
  'assistant',
  'worked_out',
] as const;
export const beliefSource = z.strictObject({
  kind: z.enum(BELIEF_SOURCE_KINDS),
  /** "you told me in chat, Sep 29", "from your email, Mar 3". */
  text,
  at: date,
  link: beliefLink.nullable(),
});
export type BeliefSource = z.infer<typeof beliefSource>;

export const belief = z.strictObject({
  id,
  label: text,
  value,
  category: beliefCategory,
  source: beliefSource,
  trust: beliefTrust,
  trust_label: text,
  /** When the belief was first learned. */
  learned_at: date,
  /** When its current value was recorded. */
  changed_at: date,
  last_used: date.nullable(),
  /** The current value is the person's own correction. */
  corrected: z.boolean(),
  /** Two statements disagree and a question about them is open. */
  disputed: z.boolean(),
  /** Earlier versions kept in its history. */
  earlier: count,
  /** Pass back unchanged when correcting, so an edit never lands on a newer value. */
  version: id,
});
export type Belief = z.infer<typeof belief>;
export const beliefList = z.strictObject({ beliefs: z.array(belief), time_zone: text });

export const beliefVersion = z.strictObject({
  value,
  at: date,
  source: beliefSource,
  current: z.boolean(),
});
export const beliefHistory = z.strictObject({ label: text, versions: z.array(beliefVersion) });

/** Something the person asked Melete not to learn again. */
export const beliefBlock = z.strictObject({ id, label: text, created_at: date });
export const beliefBlockList = z.strictObject({ blocks: z.array(beliefBlock) });

export const beliefChangeKind = z.enum(['learned', 'changed', 'corrected', 'restored', 'removed']);
export const beliefChange = z.strictObject({
  belief_id: id,
  label: text,
  change: beliefChangeKind,
  value: value.nullable(),
  previous: value.nullable(),
  at: date,
});
export type BeliefChange = z.infer<typeof beliefChange>;

/** One belief a rewind moves: `to` null means it is set aside as if never learned. */
export const rewindStep = z.strictObject({
  belief_id: id,
  label: text,
  from: value.nullable(),
  to: value.nullable(),
});
export const memoryRewind = z.strictObject({
  id,
  label: text,
  created_at: date,
  undone_at: date.nullable(),
  steps: z.array(rewindStep),
  /** Beliefs that could not be moved, and why, in plain words. */
  skipped: z.array(text),
});
export type MemoryRewind = z.infer<typeof memoryRewind>;
export const memoryRewindResponse = z.strictObject({ rewind: memoryRewind });
/** Undo one local day, or one belief's changes since an instant. */
export const rewindTarget = z.union([
  z.strictObject({ day }),
  z.strictObject({ belief_id: id, since: date }),
]);
export type RewindTarget = z.infer<typeof rewindTarget>;
export const rewindPreview = z.strictObject({
  label: text,
  steps: z.array(rewindStep),
  skipped: z.array(text),
});

export const memoryDay = z.strictObject({
  day,
  label: text,
  changes: z.array(beliefChange),
  rewinds: z.array(memoryRewind),
});
export const memoryTimeline = z.strictObject({ days: z.array(memoryDay), time_zone: text });
export type MemoryTimeline = z.infer<typeof memoryTimeline>;
export const memoryTimelineQuery = z.strictObject({
  days: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),
});

export const digestItem = z.strictObject({
  belief_id: id,
  label: text,
  change: z.enum(['learned', 'changed', 'corrected']),
  value,
  previous: value.nullable(),
  at: date,
  /** The value is still what Melete believes; correct and undo are offered only then. */
  current: z.boolean(),
  version: id.nullable(),
});
export const memoryDigest = z.strictObject({
  id,
  /** The local Sunday the digest is for. */
  week_of: day,
  title: text,
  window_start: date,
  window_end: date,
  created_at: date,
  seen_at: date.nullable(),
  items: z.array(digestItem),
});
export type MemoryDigest = z.infer<typeof memoryDigest>;
export const memoryDigestResponse = z.strictObject({
  digest: memoryDigest.nullable(),
  /** When the next weekly digest is due, in the person's time zone's Sunday morning. */
  next_at: date,
});

export const beliefExportQuery = z.strictObject({ format: z.enum(['json', 'markdown']) });
export const beliefExport = z.strictObject({
  format: z.enum(['json', 'markdown']),
  filename: text,
  content: z.string().max(4_000_000),
});
export const beliefImport = z.strictObject({
  format: z.enum(['json', 'markdown']),
  content: z.string().min(1).max(2_000_000),
});
export const beliefImportResult = z.strictObject({
  imported: count,
  skipped: count,
  notes: z.array(text).max(50),
});

/** The file format an export writes and an import reads. */
export const BELIEF_FILE_FORMAT = 'melete-beliefs';
export const beliefFileEntry = z.strictObject({
  label: z.string().min(1).max(400),
  value: z.string().min(1).max(16000),
  category: beliefCategory,
  /** The claim's internal subject, so an import lands on the same subject. */
  subject: z.string().min(1).max(400),
  key: z.string().max(200).nullable(),
  kind: z.string().max(40),
  trust: beliefTrust,
  source: z.string().max(4000),
  learned_at: date,
  history: z
    .array(z.strictObject({ value: z.string().max(16000), at: date }))
    .max(100)
    .default([]),
});
export const beliefFile = z.strictObject({
  format: z.literal(BELIEF_FILE_FORMAT),
  version: z.literal(1),
  exported_at: date,
  beliefs: z.array(beliefFileEntry).max(5000),
});
export type BeliefFile = z.infer<typeof beliefFile>;

/**
 * Why an action was taken. `declared` is what the agent said it used;
 * `recalled` is what memory handed the turn the action came from, recorded when
 * the action was proposed, because the agent did not say which one it used;
 * `rule` is a standing permission the person gave.
 */
export const becauseLink = z.strictObject({
  kind: z.enum(['belief', 'rule']),
  id,
  label: text,
  basis: z.enum(['declared', 'recalled', 'rule']),
});
export type BecauseLink = z.infer<typeof becauseLink>;
