/**
 * "Show me only what needs me": a space where Melete reads everything its
 * connections hold and does the work, and the people in it see summaries and
 * action cards instead of the messages and files themselves. It is for helping
 * someone else with their accounts, such as a parent's mailbox connected into
 * a space their adult child looks after.
 *
 * It is kept with the space's rules and enforced where the originals are read,
 * not only in what the agent is told:
 *
 * - the content routes of the space's files refuse (`api/artifacts.ts`), and an
 *   original is read only through its `original` route, which notes the open
 *   here first; only speech Melete made itself plays as before;
 * - a room's memory shows each detail's label, never its words (`rooms/memory.ts`);
 * - a step's receipt, as `/actions` and the snapshot routes return it, names
 *   what was read (a path, a subject) and marks the rest as kept back;
 * - the agent's instructions say to answer with summaries and action cards and
 *   not to quote (`jobs/bundle.ts`);
 * - turning it on or off is noted too, so the person being helped can see in
 *   the space's activity what was opened, by whom and when.
 *
 * In a room, a request's work belongs to the room, so its members and other
 * owners never read its steps, screenshots or live browser at all. In a
 * personal space the person whose work it is still sees, outside this
 * setting: the agent's own words (answers, run reports, drafts it proposes),
 * its screenshots and live browser, its computer's output, and the account
 * export.
 *
 * The notes are activity records, the same log the space already keeps of what
 * was done in a person's name. They name the kind of file opened, never its
 * name or what it said.
 */
import {
  type SummariesOnlySetting,
  summariesOnlyChange,
  summariesOnlySetting,
} from '@melete/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { activityRecord, job, principal } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId, stableEntityId } from '../memory/db.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { spacePolicy } from './schema.ts';

/** The kinds of note this keeps in `activity_record`. */
export const SUMMARY_NOTES = {
  original_opened: 'space.original_opened',
  summaries_on: 'space.summaries_on',
  summaries_off: 'space.summaries_off',
} as const;
export type SummaryNote = keyof typeof SUMMARY_NOTES;

/** The note an activity record's kind is, when it is one of these. */
export function summaryNoteOf(kind: string): SummaryNote | null {
  for (const [note, value] of Object.entries(SUMMARY_NOTES))
    if (value === kind) return note as SummaryNote;
  return null;
}

/** What each note says in a space's activity. */
export const SUMMARY_NOTE_WORDS: Record<SummaryNote, string> = {
  original_opened: 'Opened the original',
  summaries_on: 'Turned on “Show me only what needs me”',
  summaries_off: 'Turned off “Show me only what needs me”',
};

/** What a content route answers in a summaries-only space. */
export const SUMMARIES_ONLY_REFUSAL =
  'This space shows only what needs you. Open the original if you need it; each open is noted in the space’s activity.';

/**
 * What the agent is told in a summaries-only space. It still reads and works
 * on everything; only what it writes to the person changes.
 */
export const SUMMARIES_ONLY_INSTRUCTION = [
  'This space is set to “Show me only what needs me”. The person is helping someone else with their accounts, and the messages, events and files here belong to that other person.',
  'Read everything you need and do the work as usual. In what you write to the person, give short summaries and action cards: what each thing is, what is due and when, what you did, and what needs their yes.',
  'Do not quote, copy or paste the text of a message, an event or a file, and do not reproduce account numbers or other details beyond what a decision needs. Describe instead.',
  'If the person asks to see the original, tell them they can open it with “Open the original” in Files, and that each open is noted in this space’s activity.',
].join(' ');

/** Whether the space is set to summaries only. A space without rules is not. */
export async function summariesOnlyIn(
  reader: Database | Transaction,
  spaceId: string,
): Promise<boolean> {
  const [row] = await reader
    .select({ on: spacePolicy.summariesOnly })
    .from(spacePolicy)
    .where(eq(spacePolicy.spaceId, spaceId));
  return row?.on === true;
}

/** The name a note gives the person who did it: their display name, else their email's first part. */
async function nameOf(reader: Database | Transaction, principalId: string): Promise<string> {
  const [row] = await reader
    .select({ name: principal.displayName, email: principal.email })
    .from(principal)
    .where(eq(principal.id, principalId));
  const name = row?.name?.trim() || row?.email.split('@')[0] || 'Someone';
  return name.slice(0, 200);
}

/**
 * A note in the space's activity, for everyone in the space to read. It names
 * what was opened or changed and who did it, never what anything said.
 */
export async function noteInActivity(
  writer: Database | Transaction,
  input: {
    spaceId: string;
    principalId: string;
    note: SummaryNote;
    /** Where it happened, such as "Files". */
    where: string;
    /** What kind of file was opened, never its name (`originalKind`). */
    destination?: string | null;
    /**
     * Notes with the same key are one note: the first is kept and the rest
     * add nothing. Only a digest of it is stored.
     */
    once?: string;
  },
): Promise<void> {
  const at = new Date();
  const insert = writer.insert(activityRecord).values({
    id: newId('act'),
    spaceId: input.spaceId,
    principalId: input.principalId,
    // Not an action: a note has its own id here, so it never meets an action's.
    actionId: input.once ? stableEntityId('note', input.once) : newId('note'),
    kind: SUMMARY_NOTES[input.note],
    effectClass: input.note === 'original_opened' ? 'read' : 'setting',
    connectionLabel: input.where.slice(0, 200),
    provider: 'melete',
    destination: input.destination ? input.destination.slice(0, 500) : null,
    outcome: 'succeeded',
    source: await nameOf(writer, input.principalId),
    happenedAt: at,
    recordedAt: at,
  });
  await (input.once ? insert.onConflictDoNothing({ target: activityRecord.actionId }) : insert);
}

/** How many notes the setting shows beside itself. */
const RECENT = 20;

async function view(
  db: Database,
  spaceId: string,
  canChange: boolean,
): Promise<SummariesOnlySetting> {
  const notes = await db
    .select({
      kind: activityRecord.kind,
      by: activityRecord.source,
      what: activityRecord.destination,
      at: activityRecord.happenedAt,
    })
    .from(activityRecord)
    .where(
      and(
        eq(activityRecord.spaceId, spaceId),
        inArray(activityRecord.kind, Object.values(SUMMARY_NOTES)),
      ),
    )
    .orderBy(desc(activityRecord.happenedAt), desc(activityRecord.id))
    .limit(RECENT);
  return summariesOnlySetting.parse({
    space_id: spaceId,
    on: await summariesOnlyIn(db, spaceId),
    can_change: canChange,
    recent: notes.flatMap((row) => {
      const note = summaryNoteOf(row.kind);
      return note ? [{ note, by: row.by, what: row.what, at: row.at.toISOString() }] : [];
    }),
  });
}

/**
 * Who may turn it on or off: the space's maker, and nobody else. In a room the
 * other owners read it and are held to it like everyone in the room; for a
 * personal space the maker is its owner.
 */
const isMaker = (access: { ownerId: string | null; principalId: string | null }) =>
  access.ownerId !== null && access.principalId === access.ownerId;

/**
 * GET and PUT `/spaces/:id/summaries-only`, for a personal space and for a
 * room alike (a room's id is its space's). The guard on `/spaces/:id` already
 * admits only the space's people to a GET and only an owner to a PUT; the
 * maker is checked here, under a share lock on the space, so a removal that
 * starts meanwhile waits for this write.
 */
export function mountSummariesOnly(app: Hono, deps: { db: Database }): void {
  const { db } = deps;

  app.get('/spaces/:id/summaries-only', async (c) => {
    const spaceId = c.req.param('id');
    const access = await spaceAuthority(db, spaceId, c.get('owner').id);
    return c.json(await view(db, spaceId, isMaker(access)));
  });

  app.put('/spaces/:id/summaries-only', async (c) => {
    const spaceId = c.req.param('id');
    const actor = c.get('owner').id as string;
    const { on } = summariesOnlyChange.parse(await c.req.json());
    await db.transaction(async (tx) => {
      const access = await spaceAuthority(tx, spaceId, actor, true);
      if (!isMaker(access))
        throw new ServiceError(
          'scope_denied',
          'Only the person who made this space can turn “Show me only what needs me” on or off.',
          403,
        );
      const [before] = await tx
        .select({ on: spacePolicy.summariesOnly })
        .from(spacePolicy)
        .where(eq(spacePolicy.spaceId, spaceId))
        .for('update');
      // The rules' own "last changed" stays theirs: only this setting is written.
      await tx
        .insert(spacePolicy)
        .values({ spaceId, summariesOnly: on })
        .onConflictDoUpdate({ target: spacePolicy.spaceId, set: { summariesOnly: on } });
      // Each real change is noted once; asking for what is already set notes nothing.
      if ((before?.on === true) !== on)
        await noteInActivity(tx, {
          spaceId,
          principalId: actor,
          note: on ? 'summaries_on' : 'summaries_off',
          where: 'Space rules',
        });
    });
    return c.json(await view(db, spaceId, true));
  });
}

/** What a receipt's words read as in a summaries-only space. */
export const RECEIPT_KEPT_BACK = 'Kept back: this space shows only what needs you.';

/** The detail fields that say what a step touched, never what anything said. */
const NAMING = ['path', 'to', 'area', 'artifact_id', 'content_hash', 'mime', 'bytes', 'message_id'];

const subjectOf = (value: unknown) =>
  value && typeof value === 'object' && typeof (value as { subject?: unknown }).subject === 'string'
    ? { subject: (value as { subject: string }).subject }
    : {};

/**
 * A step's receipt as the people in a summaries-only space read it: what was
 * touched, by path and subject, and a marker where the rest was. Fields not
 * named here are dropped, so a connector's new field is kept back by default.
 */
export function keptBackReceipt<R extends Record<string, unknown> | null>(receipt: R): R {
  if (!receipt) return receipt;
  const detail = (receipt.detail ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = { kept_back: RECEIPT_KEPT_BACK };
  for (const field of NAMING) if (field in detail) kept[field] = detail[field];
  if (detail.message !== undefined) kept.message = subjectOf(detail.message);
  if (Array.isArray(detail.messages)) kept.messages = detail.messages.map(subjectOf);
  return { ...receipt, detail: kept };
}

/** Which of these jobs are in a space set to summaries only. */
export async function summariesOnlyJobs(
  reader: Database | Transaction,
  jobIds: readonly string[],
): Promise<Set<string>> {
  if (!jobIds.length) return new Set();
  const rows = await reader
    .select({ id: job.id })
    .from(job)
    .innerJoin(spacePolicy, eq(spacePolicy.spaceId, job.spaceId))
    .where(and(inArray(job.id, [...new Set(jobIds)]), eq(spacePolicy.summariesOnly, true)));
  return new Set(rows.map((row) => row.id));
}
