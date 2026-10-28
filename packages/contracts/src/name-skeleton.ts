/**
 * When two people's names read alike. A name is folded to a skeleton, and two
 * names with the same skeleton read alike. No Node imports: the web app reads
 * this too.
 *
 * `nameSkeleton` is the fold the service refuses a name by: NFKC (fullwidth and
 * other compatibility forms become their plain letters), lower case, format
 * and other invisible characters dropped, runs of space made one, and the
 * letters in LOOKALIKES read as the Latin letter they look like. The table is
 * short on purpose: the Cyrillic, Greek, Lisu and Cherokee letters that pass
 * for Latin ones in ordinary type, and a few Latin variants. It is not the
 * whole Unicode confusables list.
 *
 * `clashSkeleton` folds further, for deciding which names a room sets apart
 * with a tell: `I`, `l`, `1` and `|` read as one letter, and `rn` as `m`. That
 * would also join ordinary distinct names, such as Eli and Ell or Arnie and
 * Amie, so the service does not refuse names by it; a tell costs nothing.
 */

/** Each run of letters reads as the Latin letter after it. Upper case forms are folded too. */
const LOOKALIKES: readonly (readonly [string, string])[] = [
  // Cyrillic, Greek, Lisu (U+A4D0..), Cherokee (U+13A0..) and Latin variants.
  ['аɑαꓮᎪ', 'a'],
  ['вβꓐᏴ', 'b'],
  ['сꓚᏟ', 'c'],
  ['ԁꓓᎠ', 'd'],
  ['еёεꓰᎬ', 'e'],
  ['ꓝ', 'f'],
  ['ɡꓖᏀ', 'g'],
  ['һнηꓧᎻ', 'h'],
  ['іїιıꓲᎥ', 'i'],
  ['јȷꓙᎫ', 'j'],
  ['кκꓗᏦ', 'k'],
  ['ӏꓡᏞ', 'l'],
  ['мμꓟᎷ', 'm'],
  ['νꓠ', 'n'],
  ['оοꓳ', 'o'],
  ['рρꓑᏢ', 'p'],
  ['ԛ', 'q'],
  ['гꓣᏒ', 'r'],
  ['ѕꓢᏚ', 's'],
  ['тτꓔᎢ', 't'],
  ['ꓴ', 'u'],
  ['ꓦᏙ', 'v'],
  ['ԝꓪᎳ', 'w'],
  ['хχꓫ', 'x'],
  ['уүυꓬᎩ', 'y'],
  ['ζꓜᏃ', 'z'],
];

const FOLD = new Map<string, string>();
for (const [letters, latin] of LOOKALIKES)
  for (const letter of letters) {
    FOLD.set(letter, latin);
    // Cherokee and some others have lower case forms of their own; both read alike.
    FOLD.set(letter.toLowerCase(), latin);
  }

/** Characters that show as nothing: format characters, the default ignorables, and the Hangul fillers. */
export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ]/gu;

/** A name's skeleton: two names the service treats as one have the same one. */
export function nameSkeleton(name: string): string {
  let folded = '';
  for (const char of name.normalize('NFKC').toLowerCase().replace(INVISIBLE, ''))
    folded += FOLD.get(char) ?? char;
  return folded.replace(/\s+/g, ' ').trim();
}

/** A looser skeleton, for which names a room sets apart: `I`, `l`, `1`, `|` are one, `rn` is `m`. */
export const clashSkeleton = (name: string): string =>
  nameSkeleton(name)
    .replace(/[il1|]/g, 'l')
    .replaceAll('rn', 'm');

/** Whether two names read as the same name to the service. */
export const sameName = (a: string, b: string): boolean => nameSkeleton(a) === nameSkeleton(b);
