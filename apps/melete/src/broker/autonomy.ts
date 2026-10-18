/**
 * How much the agent does on its own, per kind of task, as the person chose.
 *
 * A send to someone outside Melete is one of a few kinds of task: an email,
 * a chat app's message (Slack and the like, texts included), a calendar invite
 * to other people, a public post, or anything else that goes outside. For each
 * kind the person picks one level:
 *
 * - `draft`: the agent drafts and the person sends. It goes out on its own only
 *   when the person said to send it: in the message being answered, or in a
 *   routine or instructions they wrote that ask for this kind of thing.
 * - `when_confident`: it goes out on its own when what the person said before
 *   adds up to enough confidence (`proactive.ts`), and is drafted otherwise. A
 *   level the person chose themselves counts as their instruction.
 * - `always`: it goes out on its own whenever the agent does it, asked or not.
 *
 * Nothing here loosens anything else: money moves still need the person's
 * step-up, a don't-rule still asks, and a send that also deletes, carries a
 * password or goes to a recipient Melete cannot vouch for still asks. The level
 * is read by the broker at every phase, never by the model.
 *
 * The first time the agent is about to do a task of a kind the person has not
 * chosen for, a small card in the conversation asks once, with the default
 * already chosen; the work goes on at the default meanwhile. The choice is kept
 * per person and kind, changed in Settings, or by the person saying so in their
 * own message ("just send Slack replies from now on"), read under the same
 * rule as "send it" (`told.ts`): only their own words in a turn they are
 * waiting on, never quoted, forwarded or pasted text, nor a tool's output.
 */
import {
  AUTONOMY_ASK_EXPLANATION,
  AUTONOMY_CHOICES,
  AUTONOMY_LEVELS,
  type AutonomyAsk,
  type AutonomyLevel,
  TASK_KINDS,
  TASK_TITLES,
  type TaskKind,
} from '@melete/contracts';
import { sql as drizzleSql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import { pastedSpans, ownWords as personLines, type Span } from '../intents/said.ts';
import { actionKinds, type DontKind } from './dont-rules.ts';
import { sendsMail } from './proactive.ts';
import type { Query } from './records.ts';
import { appendEvent, recordId } from './records.ts';
import { ownWords } from './told.ts';

export { AUTONOMY_LEVELS, type AutonomyLevel, TASK_KINDS, type TaskKind };
/** Where a level the person chose was chosen. */
export type LevelSource = 'settings' | 'card' | 'chat';

/** What each kind is called: a heading, and as said in a sentence. */
export const TASK_NAMES: Record<TaskKind, { title: string; said: string; one: string }> = {
  email: { title: TASK_TITLES.email, said: 'email to other people', one: 'an email' },
  chat_message: {
    title: TASK_TITLES.chat_message,
    said: 'messages to other people',
    one: 'a message to someone',
  },
  calendar_invite: {
    title: TASK_TITLES.calendar_invite,
    said: 'calendar invites',
    one: 'a calendar invite',
  },
  public_post: { title: TASK_TITLES.public_post, said: 'public posts', one: 'a public post' },
  other_send: {
    title: TASK_TITLES.other_send,
    said: 'other things sent outside',
    one: 'anything else sent outside',
  },
};

/** Each level's name on a receipt. */
export const LEVEL_NAMES: Record<AutonomyLevel, { short: string }> = {
  draft: { short: 'Draft' },
  when_confident: { short: 'When confident' },
  always: { short: 'Always' },
};

/** The three levels as choices, in order. */
export const CHOICES = [...AUTONOMY_CHOICES];

/** The first-time card, from its notice. */
export function askCard(notice: {
  ask_id: string;
  task: TaskKind;
  level: AutonomyLevel;
  chosen: AutonomyLevel | null;
}): AutonomyAsk {
  return {
    id: notice.ask_id,
    task: notice.task,
    title: TASK_TITLES[notice.task],
    explanation: AUTONOMY_ASK_EXPLANATION,
    level: notice.chosen ?? notice.level,
    chosen: notice.chosen,
    choices: CHOICES,
  };
}

/** The levels each kind starts at. Mail and anything public or unusual leans to drafts. */
export const DEFAULT_LEVELS: Readonly<Record<TaskKind, AutonomyLevel>> = {
  email: 'draft',
  chat_message: 'when_confident',
  calendar_invite: 'draft',
  public_post: 'draft',
  other_send: 'draft',
};

/**
 * The operator's setting for chat apps' messages (`MELETE_MESSAGES_TO_OTHERS`):
 * the older `confidence` and `draft_only`, or a level by name. It changes the
 * default only; a level the person chose wins.
 */
export type MessagesToOthers = 'confidence' | 'draft_only' | AutonomyLevel;

export function defaultLevels(
  messagesToOthers?: MessagesToOthers,
): Record<TaskKind, AutonomyLevel> {
  const chat =
    messagesToOthers === 'draft_only'
      ? 'draft'
      : messagesToOthers === 'confidence' || messagesToOthers === undefined
        ? DEFAULT_LEVELS.chat_message
        : messagesToOthers;
  return { ...DEFAULT_LEVELS, chat_message: chat };
}

/**
 * The kind of task a send is, by its tool's name: an email, a chat app's
 * message, a calendar invite, a public post, or anything else outside. Asked
 * only of what would otherwise wait for the person as a plain send.
 */
export function sendKindOf(toolName: string): TaskKind {
  const kinds: DontKind[] = actionKinds(toolName, false);
  if (kinds.includes('contact')) return sendsMail(toolName) ? 'email' : 'chat_message';
  if (kinds.includes('calendar')) return 'calendar_invite';
  if (kinds.includes('publish')) return 'public_post';
  return 'other_send';
}

/** A tool that drafts a send for the person to send: `email.draft`, `slack.draft_message`. */
const DRAFTS = /(^|[._])(?:create_)?draft(?=$|[._])/i;

/**
 * The kind of task a draft is for, by its tool's name, read as the send it
 * stands for; null for a tool that drafts nothing. In a conversation a kind
 * kept as a draft is drafted rather than sent, and that is when it is asked about.
 */
export function draftKindOf(toolName: string): TaskKind | null {
  return DRAFTS.test(toolName) ? sendKindOf(toolName.replace(DRAFTS, '$1send')) : null;
}

/** One kind's level for a person, and whether they chose it. */
export type TaskLevel = {
  kind: TaskKind;
  level: AutonomyLevel;
  /** The person chose it (in Settings, on the card, or in their own words). */
  chosen: boolean;
  source: LevelSource | null;
  /** The card asking about it has been put in a conversation. */
  asked: boolean;
};

/**
 * Work for a room is answered by the room's own rule (`rooms/approvals.ts`)
 * and keeps its behaviour: levels are the person's own, for their own work.
 * The same three ways `roomAuthorityOf` reads a job as a room's.
 */
export async function roomWork(tx: Query, jobId: string): Promise<boolean> {
  const [row] = await tx`select 1 from job j left join principal p on p.id = j.principal_id
      left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    where j.id = ${jobId} and (j.audience = 'room' or p.kind = 'room' or r.audience = 'room')`;
  return Boolean(row);
}

/** Whose levels a job's work follows: the job's person, or the owner of a single-person install. */
export async function personOf(tx: Query, jobId: string): Promise<string | null> {
  const [row] = await tx`select coalesce(j.principal_id, (select id from owner limit 1)) as id
    from job j where j.id = ${jobId}`;
  return row?.id ? String(row.id) : null;
}

/** Every kind's level for a person, defaults filled in. */
export async function levelsFor(
  tx: Query,
  personId: string | null,
  defaults: Record<TaskKind, AutonomyLevel> = DEFAULT_LEVELS,
): Promise<Map<TaskKind, TaskLevel>> {
  const rows = personId
    ? await tx`select kind, level, set_by, asked_at from task_autonomy where principal_id = ${personId}`
    : [];
  return levelsFrom([...rows], defaults);
}

function levelsFrom(
  rows: ReadonlyArray<Record<string, unknown>>,
  defaults: Record<TaskKind, AutonomyLevel>,
): Map<TaskKind, TaskLevel> {
  const found = new Map(rows.map((row) => [String(row.kind), row]));
  return new Map(
    TASK_KINDS.map((kind) => {
      const row = found.get(kind);
      const chosen = typeof row?.level === 'string' && isLevel(row.level);
      return [
        kind,
        {
          kind,
          level: chosen ? (row?.level as AutonomyLevel) : defaults[kind],
          chosen,
          source: chosen ? ((row?.set_by ?? null) as LevelSource | null) : null,
          asked: row?.asked_at != null,
        },
      ];
    }),
  );
}

export const isLevel = (value: unknown): value is AutonomyLevel =>
  typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value);
export const isTaskKind = (value: unknown): value is TaskKind =>
  typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value);

/** The notice that puts the first-time card in a conversation. */
export const AUTONOMY_ASK_NOTICE = 'autonomy_ask';

/**
 * Ask once: the first time a person's work is about to do a task of a kind
 * they have not chosen for, record that it was asked and put the card in this
 * conversation. Only a conversation shows it, so work outside one asks later,
 * in one. Returns the ask's id when it asked now.
 */
export async function askOnce(
  tx: Query,
  input: {
    personId: string | null;
    jobId: string;
    attemptId: string | null;
    kind: TaskKind;
    level: AutonomyLevel;
  },
): Promise<string | null> {
  if (!input.personId) return null;
  const [shown] = await tx`select 1 from job j where j.id = ${input.jobId}
    and (j.kind in ('chat', 'routine') or j.experience_parent_id is not null)`;
  if (!shown || (await roomWork(tx, input.jobId))) return null;
  const askId = recordId('ask');
  const [row] =
    await tx`insert into task_autonomy (principal_id, kind, asked_at, ask_id, asked_job_id)
    values (${input.personId}, ${input.kind}, now(), ${askId}, ${input.jobId})
    on conflict (principal_id, kind) do nothing returning ask_id`;
  if (!row) return null;
  await appendEvent(
    tx,
    input.jobId,
    input.attemptId,
    'notice',
    {
      kind: AUTONOMY_ASK_NOTICE,
      ask_id: askId,
      task: input.kind,
      level: input.level,
      chosen: null,
    },
    `${AUTONOMY_ASK_NOTICE}:${askId}`,
  );
  return askId;
}

/**
 * Keep a level the person chose. A level said in a message is kept only if
 * that message is newer than the choice it replaces, so reading the same turn
 * again, or an older one, never undoes a later change in Settings. The card
 * that asked about this kind, if any, shows the choice.
 */
export async function setLevel(
  tx: Query,
  input: {
    personId: string;
    kind: TaskKind;
    level: AutonomyLevel;
    source: LevelSource;
    /** For a level said in a message: that message, and when it was sent. */
    turn?: { id: string; at: Date | string };
    /**
     * The conversation the choice was made in, which shows it as the card
     * that asks about this kind from now on.
     */
    shownIn?: { jobId: string; attemptId: string | null };
  },
): Promise<boolean> {
  const at = input.turn ? new Date(input.turn.at).toISOString() : null;
  let [row] =
    await tx`insert into task_autonomy (principal_id, kind, level, set_by, turn_id, updated_at)
    values (${input.personId}, ${input.kind}, ${input.level}, ${input.source},
      ${input.turn?.id ?? null}, coalesce(${at}::timestamptz, now()))
    on conflict (principal_id, kind) do update set level = excluded.level,
      set_by = excluded.set_by, turn_id = excluded.turn_id, updated_at = excluded.updated_at
    where ${at}::timestamptz is null
      or (task_autonomy.turn_id is distinct from excluded.turn_id
        and (task_autonomy.level is null or task_autonomy.updated_at < excluded.updated_at))
    returning ask_id, asked_job_id`;
  if (!row) return false;
  if (input.shownIn)
    [row] = await tx`update task_autonomy set ask_id = ${recordId('ask')},
        asked_job_id = ${input.shownIn.jobId}, asked_at = coalesce(asked_at, now())
      where principal_id = ${input.personId} and kind = ${input.kind}
      returning ask_id, asked_job_id`;
  if (!row) return false;
  // The conversation that asked may have been deleted since: the choice is
  // kept all the same, with no card left to show it in.
  const [shown] =
    row.ask_id && row.asked_job_id
      ? await tx`select 1 from job where id = ${String(row.asked_job_id)}`
      : [];
  if (shown)
    await appendEvent(
      tx,
      String(row.asked_job_id),
      input.shownIn?.attemptId ?? null,
      'notice',
      {
        kind: AUTONOMY_ASK_NOTICE,
        ask_id: String(row.ask_id),
        task: input.kind,
        level: input.level,
        chosen: input.level,
      },
      `${AUTONOMY_ASK_NOTICE}:${row.ask_id}:${recordId('set')}`,
    );
  return true;
}

/* ---------- a level said in the person's own words ---------- */

/** How far each level lets the agent go on its own, least first. */
const REACH: Record<AutonomyLevel, number> = { draft: 0, when_confident: 1, always: 2 };

/**
 * The longest message that may let the agent do more on its own. A standing
 * choice is a sentence or two; a long message is where someone else's words
 * hide among the person's.
 */
export const LOOSENS_WITHIN_CHARS = 400;

/** Text in quotation marks, as `told.ts` leaves it out. */
const IN_QUOTES = /"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»/g;

/**
 * The person's own words in a message: what the composer saw pasted, quoted
 * and forwarded text, code, text in quotation marks, and anything shaped like
 * a pasted letter or passage (`intents/said.ts`) are left out.
 */
function ownSaid(text: string, pasted: readonly Span[] = []): string {
  return ownWords(personLines(text, pasted));
}

/**
 * Whether a whole message is the person's own typing: short, with nothing the
 * composer saw pasted, and nothing left out as quoted, forwarded, code or a
 * pasted letter or passage. Only such a message may let the agent do more on
 * its own; anything may hold it back.
 */
export function typedWhole(text: string, pasted: readonly Span[] = []): boolean {
  if (pasted.some((span) => span.end > span.start)) return false;
  if (text.length > LOOSENS_WITHIN_CHARS) return false;
  if (/^\s*(?:```|~~~)/m.test(text)) return false;
  const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
  return (
    flat(personLines(text)) === flat(text) &&
    flat(ownWords(text)) === flat(text.replace(IN_QUOTES, ' '))
  );
}

/** Words that make what is said a standing choice, not one send. */
const STANDING =
  /\b(?:from now on|going forward|from here on(?: out)?|in (?:the )?future|by default|every time|whenever|always|anymore|any more|no need to ask|stop asking|without asking)\b/;
/** The kind of task a sentence is about. Mail is named before a chat app's message. */
const KIND_SAID: Array<[TaskKind, RegExp]> = [
  ['email', /\b(?:e-?mails?|mails?|gmail|outlook)\b/],
  [
    'calendar_invite',
    /\b(?:(?:calendar|meeting|event) (?:invites?|invitations?)|invites?|invitations?|meeting requests?)\b/,
  ],
  ['public_post', /\b(?:public posts?|posts?|posting|tweets?|tweeting|social media|linkedin)\b/],
  [
    'chat_message',
    /\b(?:slack|teams|discord|telegram|whatsapp|signal|imessage|sms|texts?|dms?|chat messages?|messages?|replies)\b/,
  ],
];
/** Asking for the agent to wait on the person: a draft. */
const SAYS_DRAFT =
  /\b(?:drafts?|drafted|drafting|let me (?:review|check|see|look|send)|ask (?:me )?(?:first|before)|check with me|show me (?:first|before|them)|wait for (?:me|my)|(?:don'?t|do not|never|stop) send(?:ing)?|i(?:'ll| will) send)\b/;
/** Leaving it to the agent's confidence. */
const SAYS_CONFIDENT =
  /\b(?:when(?:ever)? you(?:'re| are) (?:sure|confident)|if you(?:'re| are) (?:sure|confident)|when (?:you feel )?confident|use your (?:own )?judge?ment|when you know enough)\b/;
/** Letting the agent send on its own. */
const SAYS_ALWAYS =
  /\b(?:just send|go ahead and send|you can (?:just |always )?send|feel free to send|always send|send (?:them |those |these |it |replies |messages |emails? )?(?:yourself|on your own|directly|without asking)|no need to ask|(?:don'?t|do not) (?:need to )?ask(?: me)?(?: first| before)?|stop asking|without asking)\b/;
/**
 * Telling the agent not to send, a few words ahead of the send: "don't send",
 * "never email anyone", "stop posting".
 */
const HOLD_SEND =
  /\b(?:don'?t|dont|do not|never|stop|no more)\b(?:[\s,]+(?:ever|you|to|any|anyone|anybody|them|those|these|it|my|our)\b)*[\s,]+(?:send(?:ing)?|e-?mail(?:ing)?|message|messaging|text(?:ing)?|dm(?:ing)?|reply(?:ing)?|respond(?:ing)?|post(?:ing)?|tweet(?:ing)?|invite|inviting|let)\b/;
/** Telling the agent not to wait on the person: "don't ask me", "no need to check with me". */
const NOT_ASKING =
  /\b(?:don'?t|dont|do not|never|no need to|stop) (?:need to |have to )?(?:ask(?:ing)?|check(?:ing)? (?:in )?with|wait(?:ing)? (?:for|on))\b/;
/** Going ahead without the person's say: "without asking", "without checking with me". */
const WITHOUT_ASKING =
  /\bwithout (?:first )?(?:asking|checking(?: in)? with|my (?:ok|okay|approval|say-?so|go-?ahead))/;
/** Anything that says no: before "without asking" it holds the send back. */
const NEGATION =
  /\b(?:don'?t|dont|do not|never|not|no|stop|shouldn'?t|should not|must not|mustn'?t|can'?t|cannot|won'?t)\b/;

/**
 * The level one sentence asks for, or null. Where it could be read either way,
 * the reading that keeps the person in the loop wins: "don't ever send emails
 * without asking me" drafts, however its words are ordered.
 */
function levelSaid(sentence: string): AutonomyLevel | null {
  if (SAYS_CONFIDENT.test(sentence)) return 'when_confident';
  // "Never send them without asking", "I don't want emails going out without
  // asking me": a no before "without asking" asks to be asked.
  const without = WITHOUT_ASKING.exec(sentence);
  if (without && NEGATION.test(sentence.slice(0, without.index).replace(NOT_ASKING, ' ')))
    return 'draft';
  // "Don't ask me before sending" lets it go; "don't send" holds it.
  if (NOT_ASKING.test(sentence)) return 'always';
  if (HOLD_SEND.test(sentence)) return 'draft';
  if (without) return 'always';
  if (SAYS_DRAFT.test(sentence)) return 'draft';
  if (SAYS_ALWAYS.test(sentence)) return 'always';
  return null;
}
/** A question about it rather than a request. */
const QUESTION =
  /^(?:should|shall|did|does|do|is|was|has|have|how|why|what|which|who|am|are|can i|could i|may i)\b/;
const REQUEST = /^(?:can|could|would|will) you\b/;
const OPENERS =
  /^(?:(?:ok|okay|yes|yeah|great|thanks|cool|alright|so|and|then|now|also|please|right|hey)[,.!]?\s+)+/;

/**
 * Each kind's level the person sets in a message, in their own words only
 * (`ownSaid`). `pasted` is what the composer saw pasted into it.
 */
export function saidLevels(
  text: string,
  pasted: readonly Span[] = [],
): Array<{ kind: TaskKind; level: AutonomyLevel }> {
  const found = new Map<TaskKind, AutonomyLevel>();
  const sentences = ownSaid(text, pasted)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?;\n])\s*/)
    .map((part) => part.trim().replace(OPENERS, ''))
    .filter(Boolean);
  for (const sentence of sentences) {
    if (sentence.endsWith('?') && !REQUEST.test(sentence) && QUESTION.test(sentence)) continue;
    if (!STANDING.test(sentence)) continue;
    const kind = KIND_SAID.find(([, words]) => words.test(sentence))?.[0];
    if (!kind) continue;
    const level = levelSaid(sentence);
    if (level) found.set(kind, level);
  }
  return [...found].map(([kind, level]) => ({ kind, level }));
}

/**
 * The levels a message sets that may be kept, given what the person chose
 * before (`chosen`, by kind). Holding the agent back is kept from any of the
 * person's own sentences. Letting it do more than they chose (or than a
 * draft, where they chose nothing) is kept only from a message that is wholly
 * their own typing (`typedWhole`), so a sentence inside something pasted,
 * however it was pasted, never widens what the agent does.
 */
export function levelsToKeep(
  text: string,
  pasted: readonly Span[],
  chosen: ReadonlyMap<TaskKind, AutonomyLevel | null>,
): Array<{ kind: TaskKind; level: AutonomyLevel }> {
  const typed = typedWhole(text, pasted);
  return saidLevels(text, pasted).filter(
    ({ kind, level }) => typed || REACH[level] <= REACH[chosen.get(kind) ?? 'draft'],
  );
}

/** The turn an attempt answers, when the job's own person wrote it and is waiting on it. */
const ANSWERED_TURN = (attemptId: string) => drizzleSql`select t.id, t.text, t.created_at,
      t.author_principal_id,
      (select e.payload->'pasted' from event e where e.job_id = t.job_id and e.type = 'notice'
        and e.payload->>'kind' = 'user_message' and e.payload->>'text' = t.text
        and e.created_at <= t.created_at
        order by e.seq desc limit 1) as pasted
    from attempt a join experience_turn t on t.id = a.turn_id and t.job_id = a.job_id
      join job j on j.id = a.job_id
    where a.id = ${attemptId} and a.class = 'interactive'
      and t.author_principal_id = coalesce(j.principal_id, (select id from owner limit 1))`;

/**
 * Keep the levels the person set in the turn this attempt answers. Only a
 * turn the job's own person wrote, answered by an attempt they are waiting on,
 * counts: the same rule as being told to send (`toldToSend`), and only what
 * `levelsToKeep` allows. Each level kept is shown in the conversation as the
 * card that asks about it, with the choice drawn in, so a change made in a
 * message is never silent and is undone in one click. Returns what it kept.
 */
export async function keepSaidLevels(
  tx: Query,
  attemptId: string | null | undefined,
): Promise<Array<{ kind: TaskKind; level: AutonomyLevel }>> {
  if (!attemptId) return [];
  const [attempt] = await tx`select job_id from attempt where id = ${attemptId}`;
  if (!attempt || (await roomWork(tx, String(attempt.job_id)))) return [];
  const [turn] = await tx`select t.id, t.text, t.created_at, t.author_principal_id,
      (select e.payload->'pasted' from event e where e.job_id = t.job_id and e.type = 'notice'
        and e.payload->>'kind' = 'user_message' and e.payload->>'text' = t.text
        and e.created_at <= t.created_at
        order by e.seq desc limit 1) as pasted
    from attempt a join experience_turn t on t.id = a.turn_id and t.job_id = a.job_id
      join job j on j.id = a.job_id
    where a.id = ${attemptId} and a.class = 'interactive'
      and t.author_principal_id = coalesce(j.principal_id, (select id from owner limit 1))`;
  if (!turn?.text) return [];
  const personId = String(turn.author_principal_id);
  const before = await levelsFor(tx, personId);
  const kept: Array<{ kind: TaskKind; level: AutonomyLevel }> = [];
  for (const said of levelsToKeep(String(turn.text), pastedSpans(turn.pasted), chosenOf(before)))
    if (
      await setLevel(tx, {
        personId,
        kind: said.kind,
        level: said.level,
        source: 'chat',
        turn: { id: String(turn.id), at: turn.created_at as Date },
        shownIn: { jobId: String(attempt.job_id), attemptId },
      })
    )
      kept.push(said);
  return kept;
}

/** What the person chose for each kind, or null where they chose nothing. */
const chosenOf = (levels: ReadonlyMap<TaskKind, TaskLevel>) =>
  new Map([...levels].map(([kind, level]) => [kind, level.chosen ? level.level : null]));

/**
 * The levels an attempt starts with, read only: what the job's person chose,
 * with any level they set in the turn being answered (under `keepSaidLevels`'s
 * rule) already counted, since the broker keeps that one when the attempt
 * first lists its tools. For the runtime's catalog, which reads in its own
 * transaction. Null for a room's work, which keeps its own rule.
 */
export async function attemptLevelsIn(
  tx: Transaction,
  jobId: string,
  attemptId: string | null | undefined,
  defaults: Record<TaskKind, AutonomyLevel> = DEFAULT_LEVELS,
): Promise<Map<TaskKind, TaskLevel> | null> {
  const [person] = await tx.execute<Record<string, unknown>>(drizzleSql`select
      coalesce(j.principal_id, (select id from owner limit 1)) as id,
      (j.audience = 'room' or p.kind = 'room' or r.audience = 'room') as room
    from job j left join principal p on p.id = j.principal_id
      left join job r on r.id = j.experience_parent_id and r.space_id = j.space_id
    where j.id = ${jobId}`);
  // A room's work keeps its own rule (`roomWork`).
  if (!person || person.room === true) return null;
  const personId = person.id ? String(person.id) : null;
  const rows = personId
    ? await tx.execute<Record<string, unknown>>(
        drizzleSql`select kind, level, set_by, asked_at from task_autonomy where principal_id = ${personId}`,
      )
    : [];
  const levels = levelsFrom([...rows], defaults);
  if (!attemptId) return levels;
  const [turn] = await tx.execute<Record<string, unknown>>(ANSWERED_TURN(attemptId));
  if (turn?.text)
    for (const said of levelsToKeep(String(turn.text), pastedSpans(turn.pasted), chosenOf(levels)))
      levels.set(said.kind, {
        kind: said.kind,
        level: said.level,
        chosen: true,
        source: 'chat',
        asked: true,
      });
  return levels;
}

/**
 * Whether a chat may offer the agent a tool that sends directly: when the
 * person said to send in this turn, or their level for its kind lets it send
 * on its own sometimes. The broker still judges each send.
 */
export function sendsFromChat(
  toolName: string,
  told: boolean,
  levels: ReadonlyMap<TaskKind, TaskLevel>,
): boolean {
  return told || levels.get(sendKindOf(toolName))?.level !== 'draft';
}
