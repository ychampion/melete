/**
 * A saved detail is read by the person it is about. A model asked to extract
 * facts writes about "the user" (or "the owner") in the third person ("Lena,
 * the user's sister, lives in Seattle", "The owner's landlord is Mr. Patel");
 * the person reads it on their memory page, so it is put in their words:
 * "Lena, your sister, lives in Seattle", "Your landlord is Mr. Patel". A
 * note's style, as the extractor is asked to write it, drops the subject:
 * "Lives in the Mission", "Prefers aisle seats".
 */
/**
 * Who a detail on screen may call the person. Some details saved earlier say
 * "the owner"; "the owner of the café" is someone else, and stays as written.
 */
const ON_SCREEN = 'the (?:user|owner(?! of\\b))';
/**
 * Who a detail being saved may call the person: "the user" only. A new detail
 * that says "the owner" is about someone else ("The owner said the rent goes
 * up"), and is saved as written.
 */
const SAVING = 'the user';
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A detail as it is saved: only "the user" is put in the person's words. */
export const savedInPersonsWords = (content: string) => inPersonsWords(content, SAVING);

export function inPersonsWords(content: string, WHO: string = ON_SCREEN): string {
  const leading = new RegExp(`^${WHO} is (?:an? |the )?`, 'i');
  const acting = new RegExp(`^${WHO} (?=\\p{L})`, 'iu');
  let text = content.trim();
  if (new RegExp(`^${WHO}['’]s\\b`, 'i').test(text))
    text = text.replace(new RegExp(`^${WHO}['’]s\\b`, 'i'), 'Your');
  else if (leading.test(text)) {
    // "The user is a product designer" keeps its article: "A product designer".
    const article = new RegExp(`^${WHO} is (an? |the )`, 'i').exec(text)?.[1] ?? '';
    text = capitalize(`${article}${text.replace(leading, '')}`);
  } else if (acting.test(text)) text = capitalize(text.replace(acting, ''));
  return text
    .replace(new RegExp(`\\b${WHO}['’]s\\b`, 'gi'), 'your')
    .replace(new RegExp(`\\b${WHO}\\b`, 'gi'), 'you');
}
