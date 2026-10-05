/**
 * Intents: what the person wants done, said once and kept until it is done.
 *
 * An intent holds the person's own words verbatim, Melete's one-line reading of
 * them, the details it took from them, and when it has to be done by. It
 * outlives the conversation it was said in; a standing run is its worker.
 *
 * Every detail carries where it came from. A value the person's own words
 * contain is `person`; anything else, whether the model chose it or read it
 * somewhere, is `inferred`. Only `person` values are ever treated as the
 * person's instruction, and only the service decides which is which.
 */
import { z } from 'zod';
import { dateOnly, ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import type { ToolSpec } from './runtime.ts';

export const INTENT_KINDS = [
  'meeting',
  'booking',
  'purchase',
  'reply',
  'deliver',
  'remind_check',
  'watch',
  'other',
] as const;
export const intentKind = z.enum(INTENT_KINDS);
export type IntentKind = z.infer<typeof intentKind>;

/**
 * `active`: being worked on. `waiting`: on the person, someone else or an
 * event. `at_risk`: its deadline is near and it is not done. The rest are
 * closed: `done`, `failed`, `cancelled` (by the person), `expired` (its
 * deadline passed first).
 */
export const INTENT_STATES = [
  'active',
  'waiting',
  'at_risk',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export const intentState = z.enum(INTENT_STATES);
export type IntentState = z.infer<typeof intentState>;
export const OPEN_INTENT_STATES = ['active', 'waiting', 'at_risk'] as const;
export const isOpenIntent = (state: string): boolean =>
  (OPEN_INTENT_STATES as readonly string[]).includes(state);

/** Where one detail came from: the person's own words, or anywhere else. */
export const VALUE_ORIGINS = ['person', 'inferred'] as const;
export const valueOrigin = z.enum(VALUE_ORIGINS);
export type ValueOrigin = z.infer<typeof valueOrigin>;

/** Where an intent came from: said in a chat, or taken up from Companies or Waiting on. */
export const INTENT_SOURCES = ['chat', 'commitment', 'chase'] as const;
export const intentSource = z.enum(INTENT_SOURCES);
export type IntentSource = z.infer<typeof intentSource>;

const words = (max: number) => z.string().trim().min(1).max(max);
/** A moment with its offset, or a calendar day alone. */
export const instantOrDay = z.union([timestamp, dateOnly]);
/** A short tag such as `vegetarian_options` or `no_mornings`. */
const tag = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_ -]*$/i);

/** The small closed vocabulary of details; anything else goes in `notes`. */
export const intentConstraints = z.strictObject({
  window: z.strictObject({ from: instantOrDay, to: instantOrDay.optional() }).optional(),
  party: z
    .strictObject({
      size: z.number().int().min(1).max(500).optional(),
      contacts: z.array(words(120)).max(20).optional(),
    })
    .optional(),
  place: z
    .strictObject({
      name: words(120).optional(),
      kind: words(60).optional(),
      near: words(120).optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      max: z.number().positive().max(1_000_000_000),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    })
    .optional(),
  must: z.array(tag).max(10).optional(),
  must_not: z.array(tag).max(10).optional(),
  counterparties: z.array(words(200)).max(20).optional(),
  deliverable: words(300).optional(),
  notes: words(1000).optional(),
});
export type IntentConstraints = z.infer<typeof intentConstraints>;

/** What a conversation sends to keep hold of what the person wants. */
export const intentCaptureInput = z.strictObject({
  /** Melete's one-line reading, in plain words: "Book a table for the family birthday". */
  title: words(120),
  kind: intentKind,
  constraints: intentConstraints.optional(),
  /** When it has to be done by: a moment, or a day. */
  deadline_at: instantOrDay.optional(),
  /** How to tell it is done. */
  done_when: words(300).optional(),
  /** The person's message it came from; left out, their latest one in this conversation. */
  message_id: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});
export type IntentCaptureInput = z.infer<typeof intentCaptureInput>;

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const text = { type: 'string' };
const when = {
  type: 'string',
  description:
    'An ISO date-time with its offset ("2026-10-06T19:00:00-07:00"), or a day alone ("2026-10-06").',
};

export const INTENT_CAPTURE_TOOL: ToolSpec = {
  name: 'intent.capture',
  description:
    'Keep hold of something the person wants done that takes more than this reply: a booking, a purchase, a meeting to arrange, a reply to get, something to deliver or check by a time. Melete keeps it past this conversation, works on it in the background and watches its deadline. Fill in only what the person said or clearly meant; details they did not say are shown to them as your guess. Then tell the person the read-back line it returns, in one sentence.',
  effect_class: 'write_reversible',
  connection_id: null,
  input_schema: obj(
    {
      title: { type: 'string', description: 'Your one-line reading of what they want.' },
      kind: { type: 'string', enum: [...INTENT_KINDS] },
      constraints: obj(
        {
          window: obj({ from: when, to: when }, ['from']),
          party: obj(
            { size: { type: 'integer', minimum: 1 }, contacts: { type: 'array', items: text } },
            [],
          ),
          place: obj({ name: text, kind: text, near: text }, []),
          budget: obj(
            {
              max: { type: 'number' },
              currency: { type: 'string', description: 'A three-letter code such as USD.' },
            },
            ['max'],
          ),
          must: { type: 'array', items: text, description: 'Short tags: "vegetarian_options".' },
          must_not: { type: 'array', items: text },
          counterparties: {
            type: 'array',
            items: text,
            description: 'People or businesses involved.',
          },
          deliverable: text,
          notes: text,
        },
        [],
      ),
      deadline_at: { ...when, description: `When it has to be done by. ${when.description}` },
      done_when: { type: 'string', description: 'How to tell it is done.' },
      message_id: {
        type: 'string',
        description: 'The person’s message it came from, when it is not their latest.',
      },
    },
    ['title', 'kind'],
  ),
};
export const INTENT_TOOL_NAMES: readonly string[] = [INTENT_CAPTURE_TOOL.name];

/** The intent tools an attempt of this kind of job is offered. */
export function intentScopes(kind: string): string[] {
  return kind === 'chat' ? [INTENT_CAPTURE_TOOL.name] : [];
}

/**
 * The details a person may correct from the read-back, by path. What they
 * type becomes theirs.
 */
export const INTENT_EDITABLE_PATHS = [
  'title',
  'deadline_at',
  'window.from',
  'window.to',
  'party.size',
  'place.name',
  'place.kind',
  'place.near',
  'budget.max',
  'deliverable',
  'notes',
] as const;
export const intentEditablePath = z.enum(INTENT_EDITABLE_PATHS);

export const intentEdit = z.strictObject({
  /** The version the person was looking at; a later change refuses the edit. */
  version: z.number().int().min(1),
  /** The values the person changed, by path. Null clears one. */
  values: z
    .partialRecord(intentEditablePath, z.union([z.string().max(1000), z.number(), z.null()]))
    .refine((values) => Object.keys(values).length > 0, 'Change at least one detail.'),
});
export type IntentEdit = z.infer<typeof intentEdit>;

/** One detail of the read-back line, and where it came from. */
export const readBackPart = z.strictObject({
  path: z.string(),
  text: z.string(),
  origin: valueOrigin,
});
export type ReadBackPart = z.infer<typeof readBackPart>;

export const intentView = z.strictObject({
  id: prefixedId(ID_PREFIXES.intent),
  kind: intentKind,
  source: intentSource,
  /** The person's own words, as they said them; empty when it was taken up with a tap. */
  words: z.string(),
  title: z.string(),
  /** "On it: …", with every detail Melete chose marked as its guess. */
  read_back: z.strictObject({ line: z.string(), parts: z.array(readBackPart) }),
  constraints: intentConstraints,
  /** Where each detail came from, by path ("place.name", "deadline_at"). */
  origins: z.record(z.string(), valueOrigin),
  state: intentState,
  /** What happens next, in plain words. */
  next_step: z.string().nullable(),
  deadline_at: timestamp.nullable(),
  deadline_origin: valueOrigin.nullable(),
  conversation_id: z.string().nullable(),
  run_id: z.string().nullable(),
  version: z.number().int(),
  closed_reason: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type IntentView = z.infer<typeof intentView>;
export const intentList = z.strictObject({ intents: z.array(intentView) });
export const intentResponse = z.strictObject({ intent: intentView });

/** What cancelling did to each thing the intent's work changed, newest first. */
export const intentEffectOutcome = z.strictObject({
  action_id: z.string(),
  title: z.string(),
  outcome: z.enum(['reversed', 'kept', 'failed']),
  reason: z.string().nullable(),
});
export const intentCancelResponse = z.strictObject({
  intent: intentView,
  effects: z.array(intentEffectOutcome),
});
export type IntentCancelResponse = z.infer<typeof intentCancelResponse>;
