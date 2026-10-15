/**
 * A saved detail is read by the person it is about. A model asked to extract
 * facts writes about "the user" (or "the owner") in the third person ("Lena,
 * the user's sister, lives in Seattle", "The owner's landlord is Mr. Patel");
 * the person reads it on their memory page, so it is put in their words:
 * "Lena, your sister, lives in Seattle", "Your landlord is Mr. Patel". A
 * note's style, as the extractor is asked to write it, drops the subject:
 * "Lives in the Mission", "Prefers aisle seats".
 */
import { PERSON_HEADS, SELF, whoseDetail } from './labels.ts';

/**
 * Who a detail filed under the person themself (self.diet, person.owner.city)
 * may call them on screen: some saved earlier say "the owner". "The owner of
 * the café" is someone else, and stays as written.
 */
const OWNER = 'the (?:user|owner(?! of\\b))';
/**
 * Who any other detail may call the person: "the user" only. Filed anywhere
 * else, "the owner" is someone else ("The owner said the rent goes up"), and
 * the detail is saved and shown as written.
 */
const USER = 'the user';
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A detail as it is saved: only "the user" is put in the person's words. */
export const savedInPersonsWords = (content: string) => reworded(content, USER);

/** Whether a detail is filed under the person themself: self.diet, owner.city, person.owner.city. */
function underOwner(domainKey: string, content: string): boolean {
  const [head = '', subject = ''] = domainKey.split('.');
  if (SELF.has(head)) return true;
  return (
    PERSON_HEADS.has(head) && SELF.has(subject) && whoseDetail(domainKey, content).kind === 'self'
  );
}

/** A detail as the person reads it, filed under `domainKey`. */
export function inPersonsWords(content: string, domainKey: string): string {
  return reworded(content, underOwner(domainKey, content) ? OWNER : USER);
}

function reworded(content: string, WHO: string): string {
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
