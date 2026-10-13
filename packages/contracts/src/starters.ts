/**
 * Starter tasks: the one-tap requests a new person's Home offers until they
 * have a few chats of their own. Each shows one thing the assistant can do
 * with nothing connected, and none sends a message to anyone, buys anything
 * or needs a sign-in somewhere else.
 *
 * The list is data. An installation's operator can replace it with their own
 * through MELETE_STARTERS, a JSON array of these entries, checked when the
 * service starts. Tapping a starter writes its words into the composer; the
 * person edits them and sends, and nothing is sent for them.
 *
 * A starter's words may hold `{city}`, filled from what the service knows of
 * where the person is, and one blank in square brackets, such as
 * `[a city]`. The brackets never reach the composer: the words inside them
 * are selected there, so the first thing the person types replaces them.
 */
import { z } from 'zod';

/** The icons a starter may show; each is one the web app draws. */
export const STARTER_ICONS = [
  'mapPin',
  'bell',
  'fileText',
  'upload',
  'globe',
  'compass',
  'sparkles',
  'calendar',
  'search',
  'clock',
] as const;

/** What a starter shows off, for operators sorting their own list. */
export const STARTER_CAPABILITIES = [
  'research',
  'reminders',
  'files_out',
  'files_in',
  'monitoring',
  'planning',
  'other',
] as const;

/** How many starters Home shows at most. */
export const STARTER_LIMIT = 6;
/** Once a person has this many chats, Home stops offering starters. */
export const STARTER_CHAT_LIMIT = 3;

const starterIcon = z.enum(STARTER_ICONS);
const starterCapability = z.enum(STARTER_CAPABILITIES);

const BLANK = /\[([^[\]]{1,60})\]/g;

export const starterTask = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes.'),
    /** The words on the button. */
    label: z.string().trim().min(1).max(60),
    /** The words put in the composer, with an optional `{city}` and at most one `[blank]`. */
    text: z.string().trim().min(1).max(400),
    icon: starterIcon,
    capability: starterCapability,
  })
  .refine((starter) => (starter.text.match(BLANK) ?? []).length <= 1, {
    message: 'A starter has at most one [blank].',
    path: ['text'],
  })
  .refine((starter) => !/[[\]]/.test(starter.text.replace(BLANK, '')), {
    message: 'Square brackets are only for one [blank].',
    path: ['text'],
  });
export type StarterTask = z.infer<typeof starterTask>;

export const starterList = z
  .array(starterTask)
  .min(1)
  .max(STARTER_LIMIT)
  .refine((list) => new Set(list.map((starter) => starter.id)).size === list.length, {
    message: 'Each starter needs its own id.',
  });

/**
 * The starters a new installation offers. Every one works with no apps
 * connected: the web, reminders, files made and files read, a watched page,
 * and a plan.
 */
export const DEFAULT_STARTERS: readonly StarterTask[] = [
  {
    id: 'coffee-nearby',
    label: 'Coffee shops nearby',
    text: 'Find 3 well-reviewed coffee shops near {city} and put them in a short list.',
    icon: 'mapPin',
    capability: 'research',
  },
  {
    id: 'stretch-reminder',
    label: 'Remind me to stretch',
    text: 'Remind me in 10 minutes to stretch.',
    icon: 'bell',
    capability: 'reminders',
  },
  {
    id: 'tech-news-pdf',
    label: 'Tech news as a PDF',
    text: 'Make a one-page PDF summary of today’s top tech news, with links.',
    icon: 'fileText',
    capability: 'files_out',
  },
  {
    id: 'facts-from-file',
    label: 'Pull facts from a file',
    text: 'I’ve attached a PDF or photo. Pull out the key facts.',
    icon: 'upload',
    capability: 'files_in',
  },
  {
    id: 'watch-page',
    label: 'Watch a page',
    text: 'Watch [the page’s address] and tell me when it changes.',
    icon: 'globe',
    capability: 'monitoring',
  },
  {
    id: 'budget-trip',
    label: 'Plan a trip',
    text: 'Plan a 3-day trip to [a city] on a budget.',
    icon: 'compass',
    capability: 'planning',
  },
];

/**
 * The city in an IANA time zone's name, as a place a person would say:
 * `America/Los_Angeles` is "Los Angeles". A zone that names no city, such as
 * UTC or an offset, gives null.
 */
export function cityFromTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  const parts = zone.split('/');
  if (parts.length < 2 || ['Etc', 'SystemV', 'US', 'Canada'].includes(parts[0] ?? '')) return null;
  const city = (parts.at(-1) ?? '').replaceAll('_', ' ').trim();
  return /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(city) ? city : null;
}

export const starterView = z.strictObject({
  id: z.string(),
  label: z.string(),
  icon: starterIcon,
  capability: starterCapability,
  /** The words for the composer, ready to edit. */
  text: z.string(),
  /** The part of `text` to select so the first thing typed replaces it; null for none. */
  select: z.strictObject({ start: z.number().int(), end: z.number().int() }).nullable(),
});
export type StarterView = z.infer<typeof starterView>;

/**
 * A starter's words for the composer: `{city}` becomes a blank holding the
 * city when one is known, or "your city"; the first blank's brackets are
 * dropped and its words selected.
 */
export function fillStarter(starter: StarterTask, city: string | null): StarterView {
  const words = starter.text.replaceAll('{city}', `[${city ?? 'your city'}]`);
  let select: StarterView['select'] = null;
  let text = '';
  let last = 0;
  for (const match of words.matchAll(BLANK)) {
    const inner = match[1] ?? '';
    text += words.slice(last, match.index);
    if (!select) select = { start: text.length, end: text.length + inner.length };
    text += inner;
    last = (match.index ?? 0) + match[0].length;
  }
  text += words.slice(last);
  return {
    id: starter.id,
    label: starter.label,
    icon: starter.icon,
    capability: starter.capability,
    text,
    select,
  };
}

/**
 * Whether Home offers starters: once setup is done, until the person has
 * STARTER_CHAT_LIMIT chats or puts them away. Why not, when not.
 */
export function starterVisibility(state: {
  onboarded: boolean;
  dismissed: boolean;
  chats: number;
}): { show: boolean; reason: 'not_onboarded' | 'dismissed' | 'has_chats' | null } {
  if (!state.onboarded) return { show: false, reason: 'not_onboarded' };
  if (state.dismissed) return { show: false, reason: 'dismissed' };
  if (state.chats >= STARTER_CHAT_LIMIT) return { show: false, reason: 'has_chats' };
  return { show: true, reason: null };
}

export const startersResponse = z.strictObject({
  show: z.boolean(),
  /** Why none are offered: setup is not finished, they were put away, or there are chats enough. */
  reason: z.enum(['not_onboarded', 'dismissed', 'has_chats']).nullable(),
  starters: z.array(starterView).max(STARTER_LIMIT),
});
export type StartersResponse = z.infer<typeof startersResponse>;
