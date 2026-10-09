/**
 * A saved detail is read by the person it is about. A model asked to extract
 * facts writes about "the user" in the third person ("Lena, the user's sister,
 * lives in Seattle", "The user is vegetarian"); the person reads it on their
 * memory page, so it is put in their words: "Lena, your sister, lives in
 * Seattle", "Vegetarian". A note's style, as the extractor is asked to write
 * it, drops the subject: "Lives in the Mission", "Prefers aisle seats".
 */
const WHO = 'the user';
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function inPersonsWords(content: string): string {
  const leading = new RegExp(`^${WHO} is (?:an? |the )?`, 'i');
  const acting = new RegExp(`^${WHO} (?=\\p{L})`, 'iu');
  let text = content.trim();
  if (new RegExp(`^${WHO}['’]s\\b`, 'i').test(text))
    text = text.replace(new RegExp(`^${WHO}['’]s\\b`, 'i'), 'Your');
  else if (leading.test(text)) {
    // "The user is a product designer" keeps its article: "A product designer".
    const article = /^the user is (an? |the )/i.exec(text)?.[1] ?? '';
    text = capitalize(`${article}${text.replace(leading, '')}`);
  } else if (acting.test(text)) text = capitalize(text.replace(acting, ''));
  return text
    .replace(new RegExp(`\\b${WHO}['’]s\\b`, 'gi'), 'your')
    .replace(new RegExp(`\\b${WHO}\\b`, 'gi'), 'you');
}
