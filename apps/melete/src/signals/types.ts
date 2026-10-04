/**
 * What a connector offers the signal poller: a way to read what changed.
 *
 * A mailbox hands back the messages that arrived since its cursor and a new
 * cursor. A calendar hands back every occurrence in a window, one per
 * instance of a repeating event, and the poller works out what changed by
 * comparing with what it kept from the last read. Neither ever sends anything.
 */
import type { MailMessage } from '../connectors/mail-transport.ts';

/** One new message, and the key that makes a second sighting of it the same event. */
export type NewMail = MailMessage & {
  /** Stable for the message across reads: its Message-ID, or the provider's own id. */
  key: string;
  /** What `email.read` takes to open it: an IMAP UID or a provider id. */
  read_key: number | string;
};

export type MailRead = {
  /** Where the next read starts. */
  cursor: string;
  messages: NewMail[];
};

export type MailReadOptions = {
  /** At most this many messages are read in one go; the cursor stops after the last one. */
  limit: number;
  /** True when a message with this key was already delivered, so it need not be fetched. */
  seen?: (key: string) => Promise<boolean>;
  now?: number;
};

/** A mailbox that can say what arrived since a cursor. A null cursor starts from now. */
export interface MailChanges {
  changes(cursor: string | null, options: MailReadOptions): Promise<MailRead>;
}

export type OccurrenceStatus = 'confirmed' | 'tentative' | 'cancelled';

/**
 * One occurrence of a calendar event. A single event is one occurrence with no
 * `occurrence` id; each instance of a repeating one carries the start it was
 * scheduled at (its recurrence id), which stays the same when the instance is
 * moved, so a moved Tuesday is the same Tuesday at a new time.
 */
export type Occurrence = {
  /** The event, or the series an instance belongs to. */
  uid: string;
  /** The instance's original start, as a UTC instant or an all-day date; null for a single event. */
  occurrence: string | null;
  title: string;
  /** A UTC instant (`2026-10-05T16:00:00.000Z`), or a date for an all-day event. */
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  status: OccurrenceStatus;
  /** Guests other than the calendar's own account. */
  attendees: number;
  /** The event's own time zone, when the source names one. */
  time_zone: string | null;
  /** When the provider says the event last changed, if it says. */
  updated_at?: string | null;
  /** The provider's own id for this instance, to look it up again. */
  ref?: string | null;
  /** False when the event is marked free, so it does not block the time; left out when unknown. */
  busy?: boolean;
  /** True when the event is marked important or high priority. */
  important?: boolean;
  /** True when Melete itself made the event. */
  melete?: boolean;
};

export type CalendarWindow = { from: string; to: string };

/**
 * One read of a calendar. `complete` is false when the source stopped before
 * the end of the window (too many occurrences to list), and then nothing past
 * the last occurrence it did list is taken as removed.
 */
export type CalendarRead = {
  items: readonly Occurrence[];
  complete: boolean;
};

/**
 * What became of an occurrence a read no longer lists: where it is now (moved
 * out of the window, perhaps), `gone` when the provider says it no longer
 * exists or was cancelled, or `unknown`.
 */
export type Confirmed = Occurrence | 'gone' | 'unknown';

/** A lookup that could not be made this time: the occurrence is kept and asked about again. */
export type Lookup = Confirmed | 'failed';

/** A calendar that can list the occurrences touching a window. */
export interface CalendarOccurrences {
  occurrences(window: CalendarWindow): Promise<CalendarRead>;
  /** Look one occurrence up again by the provider's own id. */
  confirm?(occurrence: {
    uid: string;
    occurrence: string | null;
    ref: string | null;
  }): Promise<Confirmed>;
}

/** A provider asking to be left alone, or answering with an error, as the poller reads it. */
export class SourceError extends Error {
  constructor(
    readonly status: number,
    /** Seconds the provider asked for, from Retry-After. */
    readonly retryAfter: number | null = null,
  ) {
    super(`source_${status}`);
  }
}

/** Retry-After as seconds, from a number or an HTTP date; null when absent or unreadable. */
export function retryAfterOf(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 86_400);
  const at = Date.parse(header);
  return Number.isNaN(at)
    ? null
    : Math.max(0, Math.min(Math.ceil((at - Date.now()) / 1000), 86_400));
}

/** The error a failed provider answer becomes, its body discarded. */
export async function sourceError(response: Response): Promise<SourceError> {
  await response.body?.cancel().catch(() => {});
  return new SourceError(response.status, retryAfterOf(response));
}

export type SignalSource =
  | ({ stream: 'mail' } & MailChanges)
  | ({ stream: 'calendar' } & CalendarOccurrences);
