/**
 * Links to the pages an answer's results came from.
 *
 * A person asked for the cheapest flight and got the fare, the times and the
 * airline, but no way to reach that fare; the same for a transit route. The
 * agent is told to link what it found by the address it opened. When an
 * answer still has no link at all, this adds one compact line of links, made
 * only from pages the turn itself opened (the same reads `citations.ts`
 * trusts) and only from those the answer names: by the site ("Adafruit",
 * "adafruit.com") or by the page's own title ("Raspberry Pi 5"). A search
 * result the turn never opened is never linked, and neither is a page the
 * answer does not talk about.
 *
 * It stays small: at most three links, one page per site unless the answer
 * names several of that site's pages by title. The same input always gives
 * the same output.
 */
import { hideSecrets } from './answer-filter.ts';

export type VisitedPage = { url: string; title: string | null };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** The most links one answer gets. */
export const MAX_LINKS = 3;

/**
 * Every page the turn opened, once each, in the order it opened them: a page
 * `web.fetch` read (where it ended up), and a page the browser or the agent's
 * computer brought to the front, alone or as a step of a batch. A search is
 * not an opening, and an open the window never showed is not either.
 */
export function pagesVisited(
  actions: readonly { kind: string; receipt: unknown; payload?: unknown }[],
): VisitedPage[] {
  const pages: VisitedPage[] = [];
  const add = (url: unknown, title: unknown) => {
    const address = text(url);
    if (address) pages.push({ url: address, title: text(title) });
  };
  for (const action of actions) {
    const detail = object(object(action.receipt).detail);
    if (action.kind === 'web.fetch') add(detail.final_url ?? detail.url, detail.title);
    else if (action.kind === 'browser.open' || action.kind === 'computer.open') {
      if (detail.navigated === false) continue;
      add(
        detail.address ?? detail.final_url ?? detail.url ?? object(action.payload).url,
        detail.title ?? detail.window,
      );
    } else if (action.kind === 'computer.batch')
      for (const step of Array.isArray(detail.steps) ? detail.steps : []) {
        const opened = object(step);
        if (opened.computer === 'open' && opened.navigated !== false)
          add(opened.address ?? opened.url, opened.window ?? opened.title);
      }
  }
  return pages;
}

/** Two-part endings a site's own name sits in front of ("bbc.co.uk"). */
const SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu|ne|or)$/;

/**
 * A page address that may be shown to the person: a public web address, with
 * no credential in it, no sign-in token, nothing that reads as a secret, and
 * no fragment. Its query is kept, since that is often the result itself (a
 * fare search, a route).
 */
export function linkable(value: string): URL | null {
  if (value.length > 2000 || /[?&#](?:access|refresh|id)_token=|[?&](?:code|state)=/i.test(value))
    return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  // A name on the local network or a bare address is nobody else's page.
  if (
    !host.includes('.') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[') ||
    /\.(?:local|localhost|internal|lan|home|test|example|invalid)$/.test(host)
  )
    return null;
  parsed.hash = '';
  if (hideSecrets(parsed.href) !== parsed.href) return null;
  return parsed;
}

function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const keep =
    labels.length >= 3 &&
    (labels.at(-1) as string).length === 2 &&
    SECOND_LEVEL.test(labels.at(-2) as string)
      ? 3
      : 2;
  return labels.slice(-keep).join('.');
}

/** Lower-case words separated by single spaces, so names match whole words. */
const words = (value: string) =>
  ` ${value
    .toLowerCase()
    .replace(/['’]s\b/g, 's')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/** Letters and digits only: "Federal Reserve" and "federalreserve" read the same. */
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** A window's title ends with the browser's name; the page's title is before it. */
const BROWSER_SUFFIX =
  /\s+[-–—]\s+(?:google chrome|chromium|mozilla firefox|firefox|microsoft edge|safari)$/i;

/** Titles that name no result: a site's front door, a sign-in, an error. */
const GENERIC =
  /^(?:home|homepage|search|results?|search results|sign in|log in|login|error|untitled|new tab|loading|page not found|not found|access denied|just a moment)$/;

/**
 * The words a page's title is known by: its first part, before the site's
 * name or a qualifier ("Oakland, California - Wikipedia" is "Oakland,
 * California", also known as "Oakland").
 */
function titleKeys(title: string | null): string[] {
  if (!title) return [];
  const bare = title.replace(BROWSER_SUFFIX, '').trim();
  const first = bare.split(/\s+[-–—|:·•]\s+|\s+\|\s+/)[0]?.trim() ?? '';
  const keys = [first, first.split(/,\s+|\s+\(/)[0]?.trim() ?? ''];
  return [...new Set(keys)].filter((key) => {
    const plain = words(key).trim();
    return squash(key).length >= 5 && !GENERIC.test(plain);
  });
}

type Candidate = {
  url: string;
  site: string;
  label: string;
  /** 2: the answer names this page's title; 1: it names only the site. */
  strength: 0 | 1 | 2;
  order: number;
};

/**
 * The answer already links somewhere, as a link, a web address or a site with
 * a path ("adafruit.com/product/5813"): the agent chose its links.
 */
const HAS_LINK =
  /\[[^\]\n]{1,300}\]\(\s*https?:\/\/|https?:\/\/[^\s)<>\]]|(?<![@\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)]/i;

/** Markdown that cannot break: brackets in the words, parentheses and spaces in the address. */
const label = (value: string) =>
  value
    .replace(/[[\]\\*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
const href = (url: URL) =>
  url.href.replace(
    /[()\s]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );

/**
 * The pages `answer` names, among those the turn visited, as links: at most
 * three, strongest first by how the answer names them, then in the order the
 * turn opened them.
 */
export function linksFor(
  answer: string,
  visited: readonly VisitedPage[],
): { label: string; url: string }[] {
  const said = words(answer);
  const saidTight = squash(answer);
  const byUrl = new Map<string, Candidate>();
  visited.forEach((page, order) => {
    const url = linkable(page.url);
    if (!url) return;
    const site = siteOf(url.hostname);
    const name = site.split('.')[0] as string;
    const keys = titleKeys(page.title);
    // A title that holds the site's own name ("Google Maps") names the site, not one result.
    const named = keys.find(
      (key) => said.includes(words(key)) && !(name.length >= 4 && words(key).includes(` ${name} `)),
    );
    const siteNamed =
      keys.some((key) => said.includes(words(key))) ||
      said.includes(words(site)) ||
      (name.length >= 4 && said.includes(` ${name} `)) ||
      (name.length >= 8 && saidTight.includes(name));
    const strength: Candidate['strength'] = named ? 2 : siteNamed ? 1 : 0;
    if (!strength) return;
    const key = href(url);
    const previous = byUrl.get(key);
    // The same page opened twice is one link, as strong as its best naming.
    if (previous && previous.strength >= strength) return;
    byUrl.set(key, {
      url: key,
      site,
      label: label(named ?? keys[0] ?? url.hostname.replace(/^www\./, '')) || site,
      strength,
      order: previous?.order ?? order,
    });
  });
  // Per site: the pages named by title, or else the last page of it the turn opened.
  const bySite = new Map<string, Candidate[]>();
  for (const candidate of byUrl.values())
    bySite.set(candidate.site, [...(bySite.get(candidate.site) ?? []), candidate]);
  const chosen: Candidate[] = [];
  for (const pages of bySite.values()) {
    const titled = pages.filter((page) => page.strength === 2);
    if (titled.length) chosen.push(...titled);
    else chosen.push(pages.reduce((last, page) => (page.order > last.order ? page : last)));
  }
  return chosen
    .sort((a, b) => b.strength - a.strength || a.order - b.order)
    .slice(0, MAX_LINKS)
    .sort((a, b) => a.order - b.order)
    .map(({ label, url }) => ({ label, url }));
}

/**
 * `answer` with a closing "Links:" line when it names results from pages the
 * turn opened and links none of them; otherwise `answer` unchanged.
 */
export function withVisitedLinks(answer: string, visited: readonly VisitedPage[]): string {
  if (!answer.trim() || HAS_LINK.test(answer)) return answer;
  const links = linksFor(answer, visited);
  if (!links.length) return answer;
  const line = links.map((link) => `[${link.label}](${link.url})`).join(' · ');
  return `${answer.trimEnd()}\n\nLinks: ${line}`;
}
