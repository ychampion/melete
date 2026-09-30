/**
 * One conversation's placeholders.
 *
 * A category and a normalised value always get the same placeholder, so the
 * model sees ⟦ACCOUNT_1⟧ for the same account on every turn. Each original
 * spelling is kept as an alias: a value that went out as a placeholder and came
 * back rehydrated is recognised exactly on the next request, whatever the
 * detectors would have made of it. The vault is sealed at rest by the store and
 * never serialised into anything that leaves the service.
 */
import {
  PRIVACY_CATEGORIES,
  PRIVACY_PLACEHOLDER_LABELS,
  type PrivacyCategory,
} from '@melete/contracts';

export type VaultEntry = {
  placeholder: string;
  category: PrivacyCategory;
  /** The first spelling seen; what a placeholder is rehydrated to. */
  value: string;
  aliases: string[];
};

export type VaultData = { v: 1; entries: VaultEntry[] };

const NUMBER_LIKE = new Set<PrivacyCategory>([
  'account',
  'card',
  'routing',
  'ssn',
  'tax_id',
  'national_id',
  'passport',
  'license',
  'phone',
]);

/** Two spellings of one detail normalise to the same key. */
export function normalizeValue(category: PrivacyCategory, value: string): string {
  if (NUMBER_LIKE.has(category)) return value.replace(/[^0-9A-Za-z+]/g, '').toUpperCase();
  if (category === 'email') return value.trim().toLowerCase();
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

const LABEL_CATEGORY = new Map(
  PRIVACY_CATEGORIES.map((category) => [PRIVACY_PLACEHOLDER_LABELS[category], category]),
);

/** The category a placeholder names, or null when it is not one of ours. */
export function placeholderCategory(placeholder: string): PrivacyCategory | null {
  const match = /^⟦([A-Z][A-Z_]*)_\d{1,6}⟧$/.exec(placeholder);
  return match?.[1] ? (LABEL_CATEGORY.get(match[1]) ?? null) : null;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORDISH = /[\p{L}\p{N}_]/u;

/**
 * A pattern for one literal, with a word boundary after it where the literal
 * ends in a word character. The boundary before it is checked by
 * `startsCleanly`: a lookbehind would slow every match many times over.
 */
export function literalPattern(value: string): string {
  const tail = WORDISH.test(value.at(-1) ?? '') ? '(?![\\p{L}\\p{N}_])' : '';
  return `${escapeRegex(value)}${tail}`;
}

/** A match that begins with a word character must not continue a word. */
export function startsCleanly(text: string, index: number, matched: string): boolean {
  if (index === 0 || !WORDISH.test(matched[0] ?? '')) return true;
  return !WORDISH.test(text.slice(Math.max(0, index - 2), index).at(-1) ?? '');
}

export class Vault {
  private readonly byKey = new Map<string, VaultEntry>();
  private readonly byPlaceholder = new Map<string, VaultEntry>();
  private readonly byAlias = new Map<string, VaultEntry>();
  private readonly counters = new Map<string, number>();
  private matcher: RegExp | null | undefined;
  /** Set when an entry or alias was added since the store last saved it. */
  changed = false;

  constructor(data?: VaultData) {
    for (const entry of data?.entries ?? []) {
      if (!PRIVACY_CATEGORIES.includes(entry.category)) continue;
      const copy = { ...entry, aliases: [...new Set([entry.value, ...entry.aliases])] };
      this.byKey.set(this.key(copy.category, copy.value), copy);
      this.byPlaceholder.set(copy.placeholder, copy);
      for (const alias of copy.aliases) this.byAlias.set(alias, copy);
      const match = /_(\d+)⟧$/.exec(copy.placeholder);
      const label = PRIVACY_PLACEHOLDER_LABELS[copy.category];
      this.counters.set(label, Math.max(this.counters.get(label) ?? 0, Number(match?.[1] ?? 0)));
    }
  }

  private key(category: PrivacyCategory, value: string) {
    return `${category}:${normalizeValue(category, value)}`;
  }

  get size(): number {
    return this.byPlaceholder.size;
  }

  /** The placeholder for this detail, made on first sight. */
  assign(category: PrivacyCategory, value: string): string {
    const key = this.key(category, value);
    let entry = this.byKey.get(key);
    if (!entry) {
      const label = PRIVACY_PLACEHOLDER_LABELS[category];
      const next = (this.counters.get(label) ?? 0) + 1;
      this.counters.set(label, next);
      entry = { placeholder: `⟦${label}_${next}⟧`, category, value, aliases: [value] };
      this.byKey.set(key, entry);
      this.byPlaceholder.set(entry.placeholder, entry);
      this.byAlias.set(value, entry);
      this.changed = true;
      this.matcher = undefined;
    } else if (!this.byAlias.has(value)) {
      entry.aliases.push(value);
      this.byAlias.set(value, entry);
      this.changed = true;
      this.matcher = undefined;
    }
    return entry.placeholder;
  }

  /** The real value behind a placeholder, or undefined for one this vault never made. */
  value(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder)?.value;
  }

  entry(placeholder: string): VaultEntry | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  aliasEntry(alias: string): VaultEntry | undefined {
    return this.byAlias.get(alias);
  }

  entries(): VaultEntry[] {
    return [...this.byPlaceholder.values()];
  }

  /**
   * One pattern over every entry: each spelling seen, and for numbers the same
   * digits with any separators, and text in any case. Each entry is a named
   * group, so a match says which entry it is.
   */
  aliases(): RegExp | null {
    if (this.matcher !== undefined) return this.matcher;
    const groups = this.entries()
      .map((entry, index) => {
        const spellings = [...new Set(entry.aliases)]
          .filter((alias) => alias.trim().length >= 3)
          .sort((a, b) => b.length - a.length);
        const alternatives = spellings.map(literalPattern);
        if (NUMBER_LIKE.has(entry.category)) {
          const flexible = numberPattern(entry.value);
          if (flexible) alternatives.push(flexible);
        }
        const longest = spellings[0]?.length ?? 0;
        return alternatives.length
          ? { source: `(?<e${index}>${alternatives.join('|')})`, longest }
          : null;
      })
      .filter((group): group is { source: string; longest: number } => group !== null)
      .sort((a, b) => b.longest - a.longest);
    this.matcher = groups.length
      ? new RegExp(groups.map((group) => group.source).join('|'), 'giu')
      : null;
    return this.matcher;
  }

  /** The entry a match of `aliases()` belongs to. */
  matchEntry(match: RegExpExecArray): VaultEntry | undefined {
    const entries = this.entries();
    for (const [name, value] of Object.entries(match.groups ?? {}))
      if (value !== undefined && name.startsWith('e')) return entries[Number(name.slice(1))];
    return undefined;
  }

  toJSON(): VaultData {
    return { v: 1, entries: this.entries() };
  }
}

export type KnownValue = { id: string; label: string; category: PrivacyCategory; value: string };

/** The same digits and letters with any spaces, dots, dashes or brackets between them. */
function numberPattern(value: string): string | null {
  const compact = value.replace(/[^0-9A-Za-z]/g, '');
  if (compact.length < 4) return null;
  return `${[...compact].map(escapeRegex).join('[\\s().-]{0,2}')}(?![A-Za-z0-9])`;
}

/**
 * A value the person listed. Numbers match with or without their separators and
 * text matches whole words regardless of case, so "Priya" also finds "priya".
 */
export function knownPattern(known: KnownValue): RegExp | null {
  const value = known.value.trim();
  if (value.length < 2) return null;
  if (NUMBER_LIKE.has(known.category)) {
    const pattern = numberPattern(value);
    return pattern ? new RegExp(pattern, 'giu') : null;
  }
  return new RegExp(literalPattern(value).replace(/ +/g, '\\s+'), 'giu');
}
