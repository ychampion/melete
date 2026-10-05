/**
 * Situations: what Melete noticed that may need the person.
 *
 * A situation is raised by a built-in detector from what a connected account
 * reported, or by a clock when a deadline comes near and a fresh look says it
 * is still unmet. It is Melete's own record, in Melete's own words: the title
 * and the reason never quote mail or an invitation. A second sighting of the
 * same thing adds to the situation already open rather than raising another.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';

/** The kinds the built-in detectors raise. */
export const SITUATION_KINDS = {
  /** A meeting's time or place changed, or it was cancelled, within a day of it. */
  meetingChanged: 'meeting.changed',
  /** Two meetings on the person's calendars overlap. */
  meetingConflict: 'meeting.conflict',
  /** A deadline is near and a fresh look says it is still unmet. */
  deadlineAtRisk: 'deadline.at_risk',
  /** A message the person sent asking for something has had no answer. */
  replyOverdue: 'reply.overdue',
} as const;
export const SITUATION_KIND_NAMES = Object.values(SITUATION_KINDS);
export const situationKind = z.enum(SITUATION_KIND_NAMES as [string, ...string[]]);
export type SituationKind = (typeof SITUATION_KINDS)[keyof typeof SITUATION_KINDS];

/**
 * How soon the person should hear. `urgent` only ever comes from a deadline
 * the person set or accepted: a detector never makes something urgent on its
 * own reading.
 */
export const URGENCIES = ['normal', 'soon', 'urgent'] as const;
export const urgency = z.enum(URGENCIES);
export type Urgency = z.infer<typeof urgency>;

/**
 * `open`: raised, delivered to the person only. `routed`: also handed to the
 * work linked to its subject. `dismissed`: the person said it was not useful.
 * `resolved`: what it was about stopped being true (the meeting moved apart,
 * the reply came). `expired`: its moment passed.
 */
export const SITUATION_STATES = ['open', 'routed', 'dismissed', 'resolved', 'expired'] as const;
export const situationState = z.enum(SITUATION_STATES);
export type SituationState = z.infer<typeof situationState>;
/** The states in which a second sighting adds to the situation rather than raising another. */
export const LIVE_SITUATION_STATES = ['open', 'routed'] as const;

/** The Melete-internal event name a situation reaches linked work under. */
export const situationEventName = (kind: string) => `situation.${kind}`;

export const situationView = z.strictObject({
  id: prefixedId(ID_PREFIXES.situation),
  kind: situationKind,
  subject_key: z.string(),
  urgency,
  /** The deadline was one the person set or accepted. */
  person_set: z.boolean(),
  title: z.string(),
  reason: z.string(),
  because: z.array(z.string()),
  state: situationState,
  deadline_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  fired_at: timestamp.nullable(),
  acked_at: timestamp.nullable(),
});
export type SituationView = z.infer<typeof situationView>;
export const situationResponse = z.strictObject({ situation: situationView });
export const situationList = z.strictObject({ situations: z.array(situationView) });

/** Whose change ends a deadline on a file: anyone's, the person's own, or someone else's. */
export const DOCUMENT_TOUCHERS = ['anyone', 'me', 'others'] as const;

/**
 * Keep a deadline on a Google Drive file: by `due_at`, the file should have
 * been changed since `since` (now, unless said). Melete looks at the file as
 * Drive has it `lead_seconds` before it is due and raises `deadline.at_risk`
 * only if it is still untouched. Naming `job_id` links the work handling it,
 * so that work hears about it too.
 */
export const documentDeadlineRequest = z
  .strictObject({
    connection_id: z.string().min(1).max(200),
    /** The file id, or a docs.google.com or drive.google.com link to it. */
    file: z.string().min(1).max(2048),
    title: z.string().trim().min(1).max(120),
    due_at: timestamp,
    lead_seconds: z
      .number()
      .int()
      .min(0)
      .max(7 * 86_400)
      .default(300),
    since: timestamp.optional(),
    by: z.enum(DOCUMENT_TOUCHERS).default('anyone'),
    job_id: z.string().min(1).max(200).optional(),
  })
  .meta({ id: 'DocumentDeadlineRequest' });
export type DocumentDeadlineRequest = z.infer<typeof documentDeadlineRequest>;

export const deadlineView = z.strictObject({
  id: z.string(),
  subject_key: z.string(),
  title: z.string(),
  due_at: timestamp,
  /** When Melete looks next. */
  fire_at: timestamp,
  person_set: z.boolean(),
  state: z.string(),
});
export const deadlineResponse = z.strictObject({ deadline: deadlineView });
