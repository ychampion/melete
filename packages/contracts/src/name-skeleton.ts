/**
 * When two people's names are the same name: when they read alike. A name is
 * folded to a skeleton, and two names with the same skeleton are one name, so
 * the service refuses the second and a room sets the two apart wherever they
 * meet. No Node imports: the web app reads this too.
 *
 * The fold is NFKC (fullwidth and other compatibility forms become their plain
 * letters), lower case, format characters such as zero-width joiners dropped,
 * runs of space made one, and the letters below read as the Latin letter they
 * look like. The table is short on purpose: the Cyrillic and Greek letters
 * that pass for Latin ones in ordinary type, and a few Latin variants. It is
 * not the whole Unicode confusables list.
 */

/** Letter, already in lower case, and the Latin letter it reads as. */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a',
  в: 'b',
  г: 'r',
  е: 'e',
  ё: 'e',
  һ: 'h',
  н: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'l',
  м: 'm',
  о: 'o',
  р: 'p',
  ԛ: 'q',
  с: 'c',
  ѕ: 's',
  т: 't',
  у: 'y',
  ү: 'y',
  ԝ: 'w',
  х: 'x',
  ԁ: 'd',
  // Greek
  α: 'a',
  β: 'b',
  ε: 'e',
  ζ: 'z',
  η: 'h',
  ι: 'i',
  κ: 'k',
  μ: 'm',
  ν: 'n',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'y',
  χ: 'x',
  // Latin variants
  ı: 'i',
  ȷ: 'j',
  ɡ: 'g',
  ɑ: 'a',
};

/** A name's skeleton: two names that read alike have the same one. */
export function nameSkeleton(name: string): string {
  let folded = '';
  for (const char of name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}/gu, ''))
    folded += LOOKALIKES[char] ?? char;
  return folded.replace(/\s+/g, ' ').trim();
}

/** Whether two names read as the same name. */
export const sameName = (a: string, b: string): boolean => nameSkeleton(a) === nameSkeleton(b);
