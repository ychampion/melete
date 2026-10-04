/**
 * What each kind of connection reports.
 *
 * A trigger listens for one event name on one connection. A name the
 * connection never produces would leave the trigger waiting for ever, which to
 * a person reads as "the watch is broken" long after they set it. So every
 * kind of connection declares the names it produces here, and a trigger on any
 * other name is refused when it is made.
 */

/** A new message in the inbox, read from the mailbox's own change feed. */
export const MAIL_RECEIVED = 'mail.received';
/** A company writing back to a message a chase sent. */
export const MAIL_REPLY = 'mail.new';

/** One occurrence of a calendar event, as the calendar changes. */
export const CALENDAR_EVENTS = {
  created: 'calendar.event.created',
  changed: 'calendar.event.changed',
  cancelled: 'calendar.event.cancelled',
} as const;
export type CalendarEventName = (typeof CALENDAR_EVENTS)[keyof typeof CALENDAR_EVENTS];

export const MAIL_EVENT_NAMES = [MAIL_RECEIVED, MAIL_REPLY] as const;
export const CALENDAR_EVENT_NAMES = [
  CALENDAR_EVENTS.created,
  CALENDAR_EVENTS.changed,
  CALENDAR_EVENTS.cancelled,
] as const;
export const PROCESS_EVENT_NAMES = [
  'process.exited',
  'process.output',
  'process.listening',
] as const;

/** The names one kind of connection produces: exact names, and families named by prefix. */
export type EventCatalog = { names: readonly string[]; prefixes: readonly string[] };

const NONE: EventCatalog = { names: [], prefixes: [] };

/**
 * The catalog of a connection, by its provider. A mailbox (IMAP, or a signed-in
 * Gmail or Outlook account) reports mail; a calendar (CalDAV, a feed, or a
 * signed-in Google or Outlook calendar) reports occurrences; an agent's
 * computer reports its background processes; a room reports the hand-offs it
 * settles. The scripted `test` connection stands in for a mailbox and a
 * calendar. Every other connection reports nothing a trigger can wait for.
 */
export function eventCatalog(provider: string): EventCatalog {
  switch (provider) {
    case 'imap':
      return { names: MAIL_EVENT_NAMES, prefixes: [] };
    case 'caldav':
      return { names: CALENDAR_EVENT_NAMES, prefixes: [] };
    case 'test':
      return { names: [...MAIL_EVENT_NAMES, ...CALENDAR_EVENT_NAMES], prefixes: [] };
    case 'sandbox':
      return { names: PROCESS_EVENT_NAMES, prefixes: [] };
    case 'room':
      return { names: [], prefixes: ['room.handoff_settled.'] };
    default:
      return NONE;
  }
}

/** Whether a connection of this provider ever produces `eventName`. */
export function producesEvent(provider: string, eventName: string): boolean {
  const catalog = eventCatalog(provider);
  return (
    catalog.names.includes(eventName) ||
    catalog.prefixes.some(
      (prefix) => eventName.startsWith(prefix) && eventName.length > prefix.length,
    )
  );
}
