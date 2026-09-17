/**
 * Deterministic lexical matching between what a job asks for and what a tool
 * says it does. No model is consulted: the same text and the same catalog
 * always produce the same order, so a catalog decision can be replayed.
 */

const STOPWORDS = new Set(
  (
    'a an the to of and or in on at for with by from is are was were be been it its this that ' +
    'these those me my i you your we our us as if then than so do does did not no yes what when ' +
    'whether which who how has have had will would can could should please until tell about into ' +
    'up out also any all only just exact exactly there here them they he she his her'
  ).split(' '),
);

/** A light suffix stripper: `restarting`, `restarts` and `restarted` meet at `restart`. */
export function stem(word: string): string {
  let value = word;
  if (value.length > 4 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
  else if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss'))
    value = value.slice(0, -1);
  if (value.length > 4 && value.endsWith('e')) value = value.slice(0, -1);
  const last = value.at(-1);
  if (value.length > 4 && last && last === value.at(-2) && !'aeiouls'.includes(last))
    value = value.slice(0, -1);
  return value;
}

/** Lowercased words and identifier segments, function words removed, nothing stemmed. */
export function words(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return [
    ...new Set(spaced.split(/[^a-z0-9]+/).filter((raw) => raw.length >= 2 && !STOPWORDS.has(raw))),
  ];
}

/** Stemmed words: `server.restart`, `serverRestart` and `server_restart` agree. */
export function terms(text: string): Set<string> {
  return new Set(words(text).map(stem));
}

export type LexicalDocument = { name: string; description: string; examples?: readonly string[] };

/** A name segment is worth more than prose: it is what the tool is, not what is said about it. */
export function relevance(query: ReadonlySet<string>, document: LexicalDocument): number {
  if (query.size === 0) return 0;
  const name = terms(document.name);
  const prose = terms([document.description, ...(document.examples ?? [])].join(' '));
  let score = 0;
  for (const term of query) {
    if (name.has(term)) score += 3;
    else if (prose.has(term)) score += 1;
  }
  return score;
}

/** At most `limit` words of the first sentence, for a names-only listing. */
export function gist(description: string, limit = 8): string {
  const sentence =
    description
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? '';
  return sentence
    .split(' ')
    .slice(0, limit)
    .join(' ')
    .replace(/[.,;:!?]+$/, '');
}
