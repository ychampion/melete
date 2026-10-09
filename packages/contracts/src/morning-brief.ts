/**
 * The morning brief's fixed parts, kept free of anything a browser cannot load
 * so the web app reads them from here (`@melete/contracts/morning-brief`). The
 * request schema is `morningBriefCreate` in experience.ts.
 */

/** The title every morning brief is saved under, so a client can tell one is set up. */
export const MORNING_BRIEF_TITLE = 'Your morning brief';

/** Topics a client may offer for the brief's news line; any short topic is accepted. */
export const MORNING_BRIEF_TOPICS = [
  'World',
  'Business',
  'Tech',
  'AI',
  'Science',
  'Sports',
  'Markets',
  'Local',
] as const;

const spoken = (items: readonly string[]) =>
  items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * What a morning brief asks of the agent. Every part that needs a connection
 * is dropped when there is none, and the weather and the news need nothing
 * connected, so a brief made before anything is connected still says something.
 * The service writes the open tasks into every routine's objective.
 */
export function morningBriefInstruction(topics: readonly string[] = []): string {
  const unique = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))];
  const news = unique.length
    ? `One or two short lines of news on ${spoken(unique)}, from a web search, each with the page you read.`
    : 'One or two short lines of news worth knowing today, from a web search, each with the page you read.';
  return [
    'Write my morning brief. Keep it to one screen, in this order:',
    '1. Today’s weather where I am, from web.weather.',
    '2. Today’s calendar events with their times, when a calendar is connected.',
    '3. What needs me today: open tasks and reminders that are due or overdue, and mail waiting on my reply when a mailbox is connected.',
    `4. ${news}`,
    'Leave out a part you have nothing for, without saying why. Always send a brief: the weather and the news need nothing connected.',
    'Only read. Ask before making any change.',
  ].join('\n');
}
