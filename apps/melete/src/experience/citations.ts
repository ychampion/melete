/**
 * Citations an answer may keep: only those a read in the same turn backs.
 *
 * A morning brief credited Bloomberg and VentureBeat while the only pages it
 * opened were aggregators. A model names a source from what a page it read
 * said, or from a search result it never opened, and the person takes the
 * name as checked. So before a turn's answer is kept, every citation in it is
 * compared with the receipts of what the turn read:
 *
 * - a page `web.fetch` read (its address, every address it was redirected
 *   through, and its title), a page opened in the browser or the agent's
 *   computer, and a service whose tool answered (Open-Meteo for the weather);
 * - a search result is not a read: its page was never opened.
 *
 * What counts as a citation is decided by where it stands, never by guessing
 * what a name is: a "Source:" or "Sources:" line and the list under it, an
 * attribution ("according to …", "(per …)", "(via …)", "(source: …)"), and a
 * parenthesis that holds only a link or a site. A link, a site name such as
 * `nist.gov` or an outlet's name such as "Tom's Guide" is backed when a site
 * the turn read has that name. One the reads do not back is taken out: a
 * source line or list item goes, a parenthesis goes, and an attribution inside
 * a sentence loses its link and is named in a closing note, so the sentence
 * still reads. Code blocks are left alone, and so is an answer with nothing
 * cited. The same input always gives the same output.
 */

export type ReadSource = { url: string; title?: string | null };

export type CitationCheck = {
  text: string;
  /** The citations taken out or flagged, as the answer named them. */
  unbacked: string[];
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Tools whose successful receipt is a page opened and read. */
const PAGE_OPENS = new Set(['browser.open', 'computer.open']);

/**
 * What one turn read, from its succeeded actions' receipts. Only Melete's own
 * records are used: the action's kind, its receipt and its payload.
 */
export function sourcesRead(
  actions: readonly { kind: string; receipt: unknown; payload?: unknown }[],
): ReadSource[] {
  const read: ReadSource[] = [];
  for (const action of actions) {
    const detail = object(object(action.receipt).detail);
    if (action.kind === 'web.fetch') {
      const title = typeof detail.title === 'string' ? detail.title : null;
      for (const url of [detail.final_url, detail.url, ...strings(detail.visited_urls)])
        if (typeof url === 'string') read.push({ url, title });
    } else if (action.kind === 'web.weather') {
      if (typeof detail.source_url === 'string')
        read.push({
          url: detail.source_url,
          title: typeof detail.source === 'string' ? detail.source : null,
        });
    } else if (PAGE_OPENS.has(action.kind) && detail.navigated !== false) {
      const url = detail.final_url ?? detail.url ?? object(action.payload).url;
      if (typeof url === 'string')
        read.push({ url, title: typeof detail.title === 'string' ? detail.title : null });
    } else if (action.kind === 'computer.batch') {
      // An open inside a batch is a page opened too, once the window showed it.
      for (const step of Array.isArray(detail.steps) ? detail.steps : []) {
        const opened = object(step);
        if (opened.computer !== 'open' || opened.navigated === false) continue;
        if (typeof opened.address === 'string')
          read.push({
            url: opened.address,
            title: typeof opened.window === 'string' ? opened.window : null,
          });
      }
    }
  }
  return read;
}

/** Two-part endings a site's own name sits in front of ("bbc.co.uk", "abc.net.au"). */
const SECOND_LEVEL = /^(?:co|com|net|org|gov|ac|edu|ne|or)$/;

/** A host as people name the site: "www.tomsguide.com" is "tomsguide.com". */
function siteOf(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const keep =
    labels.length >= 3 &&
    (labels.at(-1) as string).length === 2 &&
    SECOND_LEVEL.test(labels.at(-2) as string)
      ? 3
      : 2;
  return labels.slice(-keep).join('.');
}

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
};

/** Letters and digits only, lower case: "Tom's Guide" and "tomsguide" read the same. */
const squash = (value: string) =>
  value
    .toLowerCase()
    .replace(/'s\b|’s\b/g, 's')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '');

type Backing = { sites: Set<string>; names: Set<string>; titles: string[] };

function backing(read: readonly ReadSource[]): Backing {
  const sites = new Set<string>();
  const names = new Set<string>();
  const titles: string[] = [];
  for (const source of read) {
    const host = hostOf(source.url);
    const site = host ? siteOf(host) : null;
    if (site) {
      sites.add(site);
      const name = squash(site.split('.')[0] as string);
      if (name.length >= 3) names.add(name);
    }
    if (source.title) {
      const title = squash(source.title);
      if (title.length >= 4) titles.push(title);
    }
  }
  return { sites, names, titles };
}

const LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
const BARE_URL = /https?:\/\/[^\s)<>\]]{1,2000}/g;
const DOMAIN =
  /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|gov|edu|io|co|ai|news|info|uk|us|ca|au|de|fr|in|jp|eu|me|tv|app|dev)(?![\w-])/gi;
/** Words that name the person's own things, never a web source. */
const OWN_THINGS =
  /\b(?:you|your|yours|my|memory|melete|notes?|calendar|inbox|email|files?|conversation|chat)\b/i;

type Target = { shown: string; backed: boolean };

/** What one citation names: its links, its sites, or the outlets it names in words. */
function targets(cited: string, back: Backing): Target[] | null {
  const found: Target[] = [];
  const linked = new Set<string>();
  for (const match of cited.matchAll(LINK)) {
    const url = match[2] as string;
    linked.add(url);
    const site = siteOf(hostOf(url) ?? '');
    found.push({ shown: (match[1] as string).trim(), backed: !!site && back.sites.has(site) });
  }
  const rest = cited.replace(LINK, ' ');
  for (const match of rest.matchAll(BARE_URL)) {
    const url = (match[0] as string).replace(/[.,;:!?]+$/, '');
    if (linked.has(url)) continue;
    const site = siteOf(hostOf(url) ?? '');
    found.push({ shown: url, backed: !!site && back.sites.has(site) });
  }
  const plain = rest.replace(BARE_URL, ' ');
  for (const match of plain.matchAll(DOMAIN)) {
    const site = siteOf(match[0] as string);
    found.push({ shown: match[0] as string, backed: !!site && back.sites.has(site) });
  }
  if (found.length) return found;
  // No link or site: the outlets it names in words, each starting with a capital.
  if (OWN_THINGS.test(plain)) return null;
  const names = plain
    .replace(/[“”"*_`]/g, '')
    .split(/\s*(?:,|;|\band\b|&|\/)\s*/)
    .map((name) =>
      name
        .trim()
        .replace(/^(?:the|a|an)\s+/i, '')
        .replace(/[.:!?)(]+$/g, '')
        .trim(),
    )
    // A name starts with a capital ("Reuters", "9to5Mac"), never a year or a number alone.
    .filter((name) => /^(?:[A-Z]|\d+[A-Za-z])/.test(name) && name.length <= 60);
  if (!names.length) return null;
  return names.map((name) => {
    // "NIST's Daylight Saving Time page": the outlet is its first words.
    const words = name.split(/\s+/);
    const candidates = [name, ...words.slice(0, 3).map((_, i) => words.slice(0, i + 1).join(' '))];
    const backed = candidates.some((candidate) => {
      const key = squash(candidate);
      if (key.length < 3) return false;
      for (const known of back.names) if (key === known || key.includes(known)) return true;
      return key.length >= 4 && back.titles.some((title) => title.includes(key));
    });
    return { shown: name, backed };
  });
}

/** Links whose sites the reads do not back lose their address and keep their words. */
const unlink = (text: string, back: Backing) =>
  text.replace(LINK, (whole, label: string, url: string) => {
    const site = siteOf(hostOf(url) ?? '');
    return site && back.sites.has(site) ? whole : label;
  });

const SOURCE_LABEL =
  /^(\s*(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*|__)?)(sources?|references?|citations?)((?:\*\*|__)?\s*:?\s*(?:\*\*|__)?)\s*(.*)$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
/** A parenthesis, never the address half of a Markdown link ("[NIST](https://…)"). */
const PARENTHESIS =
  /\s?(?<!\])\((?:(?:per|via|source:|sources:|according to|from)\s+)?([^()\n]{1,400})\)/gi;
const ATTRIBUTION =
  /\b(according to|as reported by|reported by)\s+((?:\[[^\]\n]{1,300}\]\([^)\s]{1,2000}\))|[^,.;:\n()]{1,120})/gi;

/**
 * Take out or flag every citation in `answer` that the turn's reads do not back.
 * `read` is what `sourcesRead` gave for the same turn.
 */
export function checkCitations(answer: string, read: readonly ReadSource[]): CitationCheck {
  const back = backing(read);
  const unbacked: string[] = [];
  const note = (found: Target[]) => {
    for (const target of found)
      if (!target.backed && !unbacked.includes(target.shown)) unbacked.push(target.shown);
  };
  const lines = answer.split('\n');
  const out: string[] = [];
  let fenced = false;
  /** Set while the lines are the list under a "Sources:" heading; holds that heading's index. */
  let section: { heading: number; kept: number } | null = null;
  const closeSection = () => {
    if (section && section.kept === 0) out.splice(section.heading, 1);
    section = null;
  };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    if (section) {
      if (LIST_ITEM.test(line)) {
        const found = targets(line.replace(LIST_ITEM, ''), back);
        if (found && found.some((target) => !target.backed)) {
          note(found);
          if (found.every((target) => !target.backed)) continue;
          out.push(unlink(line, back));
          section.kept += 1;
          continue;
        }
        out.push(line);
        section.kept += 1;
        continue;
      }
      if (!line.trim() && section.kept === 0) continue;
      closeSection();
    }
    const label = SOURCE_LABEL.exec(line);
    if (label && (label[3]?.includes(':') || !label[4])) {
      const cited = label[4] ?? '';
      if (!cited.trim()) {
        // A heading: the list under it is the sources.
        section = { heading: out.length, kept: 0 };
        out.push(line);
        continue;
      }
      const found = targets(cited, back);
      if (found && found.some((target) => !target.backed)) {
        note(found);
        if (found.every((target) => !target.backed)) continue;
        out.push(unlink(line, back));
        continue;
      }
      out.push(line);
      continue;
    }
    let next = line.replace(PARENTHESIS, (whole, inner: string) => {
      const attributed = /^\s?\((?:per|via|source:|sources:|according to|from)\s/i.test(whole);
      const onlySource =
        new RegExp(`^(?:${LINK.source}|${BARE_URL.source}|${DOMAIN.source})$`, 'i').test(
          inner.trim(),
        ) && !/\s/.test(inner.trim().replace(LINK, 'x'));
      if (!attributed && !onlySource) return whole;
      // "(from 2019)" or "(per person)" names no source.
      const found = targets(inner, back);
      if (!found || found.every((target) => target.backed)) return whole;
      note(found);
      return '';
    });
    next = next.replace(ATTRIBUTION, (whole, _phrase: string, cited: string) => {
      const found = targets(cited, back);
      if (!found || found.every((target) => target.backed)) return whole;
      note(found);
      return unlink(whole, back);
    });
    out.push(next);
  }
  closeSection();
  if (!unbacked.length) return { text: answer, unbacked };
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return {
    text: `${text}\n\nNot cited, because nothing here was read from them: ${unbacked.join(', ')}.`,
    unbacked,
  };
}
