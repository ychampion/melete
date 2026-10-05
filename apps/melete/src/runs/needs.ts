/**
 * What a piece of background work reads that only a connection can give it,
 * and which of those this space has no working connection for.
 *
 * A routine that summarizes someone's day reads their calendar. Created in a
 * space with no calendar, it would run on schedule and find nothing, and the
 * person would not know why. So when work starts, its goal is read for the
 * sources it names, by fixed words rather than a model's judgement, and each
 * source with no active, working connection is reported, for the conversation
 * to tell the person plainly and offer to connect.
 */
import { and, eq, ne } from 'drizzle-orm';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

export type Source = 'calendar' | 'mail';

const SOURCES: { source: Source; words: RegExp; scopes: string[] }[] = [
  {
    source: 'calendar',
    words: /\b(?:calendars?|meetings?|agendas?|appointments?|my (?:day|week|morning|schedule))\b/i,
    scopes: ['calendar.list'],
  },
  {
    source: 'mail',
    words: /\b(?:e-?mails?|inbox(?:es)?|mailbox(?:es)?|unread (?:mail|messages?))\b/i,
    scopes: ['email.read', 'email.search'],
  },
];

/** The sources a goal names, in a fixed order. */
export function sourcesNamed(goal: string): Source[] {
  return SOURCES.filter((entry) => entry.words.test(goal)).map((entry) => entry.source);
}

/** The sources a goal names that no active, working connection in the space gives. */
export async function missingSources(
  tx: Transaction,
  spaceId: string,
  goal: string,
): Promise<Source[]> {
  const named = sourcesNamed(goal);
  if (!named.length) return [];
  const rows = await tx
    .select({ scopes: connection.scopes })
    .from(connection)
    .where(
      and(
        eq(connection.spaceId, spaceId),
        eq(connection.status, 'active'),
        ne(connection.health, 'failing'),
      ),
    );
  return named.filter((source) => {
    const wanted = SOURCES.find((entry) => entry.source === source)?.scopes ?? [];
    return !rows.some((row) => row.scopes.some((scope) => wanted.includes(scope)));
  });
}

const NAMES: Record<Source, string> = { calendar: 'calendar', mail: 'email' };

/** "calendar", or "calendar and email". */
export const sourceWords = (sources: Source[]) =>
  sources.map((source) => NAMES[source]).join(' and ');
