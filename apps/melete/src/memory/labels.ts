/**
 * Plain names for saved details, from their registry key or subject. Kept free
 * of other imports so every place that names a detail (the memory page, a
 * chat's work log, a room) can use it.
 */
/** Subject heads that say nothing about what a detail is. */
export const GENERIC_HEADS = new Set([
  'fact',
  'facts',
  'user',
  'owner',
  'me',
  'my',
  'self',
  'info',
  'detail',
  'details',
  'general',
  'misc',
  'imported',
  'memory',
  'pref',
  'prefs',
  'preference',
  'preferences',
]);
/** Subject heads that name someone in the person's life. */
export const PERSON_HEADS = new Set([
  'person',
  'people',
  'contact',
  'contacts',
  'family',
  'friend',
  'friends',
]);
/** Subjects that name the person themselves: their details read as "Your …", never "Owner's …". */
export const SELF = new Set(['owner', 'user', 'me', 'self', 'you', 'myself']);
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
/** A subject as a person writes it: "checkins" is "check-ins". */
const SPELLED: Record<string, string> = { checkins: 'check-ins', checkin: 'check-in' };
const said = (subject: string | undefined) => {
  const word = (subject ?? '').replaceAll('-', ' ').toLowerCase();
  return SPELLED[word] ?? word;
};

/** A plain name for what a belief is about, from its registry key or its subject. */
export function subjectLabel(key: string | null, domainKey: string): string {
  if (key) {
    const [kind, subject, field] = key.split('.');
    const name = capitalize((subject ?? '').replaceAll('-', ' '));
    const leaf = (field ?? '').replaceAll('-', ' ');
    if (kind === 'contact' && SELF.has((subject ?? '').toLowerCase())) return `Your ${leaf}`;
    if (kind === 'contact') return `${name}'s ${leaf}`;
    if (kind === 'event') return `${name} ${leaf}`;
    if (kind === 'pref') return `${capitalize(said(subject))}: ${leaf}`;
    if (kind === 'constraint') return `${name}: ${leaf}`;
  }
  const parts = (domainKey.split(':exception:')[0] ?? domainKey)
    .split(/[.:]/)
    .map((part) => part.replaceAll(/[_-]+/g, ' ').trim())
    .filter(Boolean);
  if (!parts.length) return 'Something you shared';
  const [head, ...rest] = parts as [string, ...string[]];
  if (PERSON_HEADS.has(head.toLowerCase()) && rest.length >= 2) {
    // "person.sister.lena.city" is Sister Lena's city, not "Sister's lena city".
    const [first = '', second = '', ...field] = rest;
    if (SELF.has(first.toLowerCase())) return `Your ${[second, ...field].join(' ')}`.slice(0, 200);
    // "person.sister.city" is a field of the sister's; "person.landlord.patel" names him.
    const related = RELATIONS.has(first.toLowerCase()) && !FIELDS.has(second.toLowerCase());
    const who = related ? `${capitalize(first)} ${capitalize(second)}` : capitalize(first);
    const what = related ? field : [second, ...field];
    return (what.length ? `${who}'s ${what.join(' ')}` : who).slice(0, 200);
  }
  // A detail filed under the person themself is theirs.
  if (head.toLowerCase() === 'self' && rest.length) return `Your ${rest.join(' ')}`.slice(0, 200);
  const meaningful = GENERIC_HEADS.has(head.toLowerCase()) && rest.length ? rest : parts;
  return capitalize(meaningful.join(' ')).slice(0, 200);
}

/** How the person's family and circle are named in a subject: "sister", "landlord". */
export const RELATIONS = new Set(
  (
    'sister brother sibling mother mom mum father dad parent wife husband partner spouse son ' +
    'daughter child kid friend boss manager landlord landlady roommate flatmate neighbor ' +
    'neighbour colleague coworker cousin aunt uncle grandma grandpa grandmother grandfather ' +
    'niece nephew girlfriend boyfriend fiance fiancee doctor dentist'
  ).split(' '),
);

/** Words that name a detail about someone rather than the someone. */
const FIELDS = new Set(
  (
    'city home address location birthday birthdate age phone number email job work employer ' +
    'role title name diet allergy allergies school company team gift gifts anniversary'
  ).split(' '),
);

/**
 * Words that say what a detail is about, or join such words ("lives_in",
 * "work_from_home"). A subject under a person heading made only of these is
 * a topic an earlier extraction filed the person's own detail under
 * ("person.diet.vegetarian"); any other word there is someone's name.
 */
const TOPICS = new Set([
  ...FIELDS,
  ...(
    'allergic diets dietary food foods meal meals eating drink drinks health medical medication ' +
    'medications condition conditions locations cities hometown residence lives live living based ' +
    'country neighborhood neighbourhood travel travels trip trips flight flights flying seat seats ' +
    'seating aisle window airline airlines hotel hotels preference preferences pref prefs likes ' +
    'dislikes favorite favorites favourite favourites style tone language languages communication ' +
    'jobs career office schedule availability available routine routines habit habits hours ' +
    'calendar commute contact pronouns instruction instructions rule rules note notes info ' +
    'details detail general profile personal background status away absence vacation holiday ' +
    'leave budget money bank finance finances payment payments interest interests hobby hobbies ' +
    'sport sports music in on at of from to for the and with'
  ).split(' '),
]);

/**
 * Whose detail a subject holds: the person's own; someone in their life,
 * named by the subject ("person.maya.city", "person.sam.diet" for "my friend
 * sam is vegetarian", "family.sister.allergy"); or a subject under a person
 * heading that names a topic, not someone, which an earlier extraction gave
 * the person's own detail ("person.allergy.peanuts"), so it cannot be told.
 */
export type Whose =
  | { kind: 'self' }
  | { kind: 'other'; who: string }
  | { kind: 'unknown'; who: string };

const textWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
/** The words a text writes with a capital, as names are written. */
const capitalized = (text: string) =>
  new Set(
    text
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => /^\p{Lu}/u.test(word))
      .map((word) => word.toLowerCase()),
  );
/**
 * Whether a text names someone: every word of the name is written in it, with
 * a capital ("Maya", "Mr. Patel"). A subject made of plain words, such as
 * "lives_in" for "Lives in Pune" or "diet" for "my diet", names nobody.
 */
function names(text: string, who: string): boolean {
  const said = capitalized(text);
  const name = textWords(who);
  return name.length > 0 && name.every((word) => said.has(word));
}

/**
 * Whose detail a subject holds, read from its heading. A name is read as one
 * however it is written: "sam" in "my friend sam" is someone, not a topic.
 */
export function whoseDetail(domainKey: string): Whose {
  const [head = '', subject = ''] = (domainKey.split(':exception:')[0] ?? domainKey).split('.');
  if (!PERSON_HEADS.has(head)) return { kind: 'self' };
  if (SELF.has(subject)) return { kind: 'self' };
  const who = subject.replace(/[_-]+/g, ' ').trim();
  if (!who || (!RELATIONS.has(subject) && textWords(who).every((word) => TOPICS.has(word))))
    return { kind: 'unknown', who };
  return { kind: 'other', who };
}

/**
 * Whether two details can be about the same one: both the person's own, or
 * the same someone (the same name, or one naming the other: "Sister Lena" is
 * person.lena and family.sister). The person's own detail and someone
 * else's never are, nor two different people's, however alike their words;
 * a detail under a topic that names that someone is theirs ("Priya owns the
 * Atlas project" under project.atlas). A subject that names a topic, not
 * someone, may be the person's own.
 */
export function sameWhose(a: Whose, aText: string, b: Whose, bText: string): boolean {
  if (a.kind === 'unknown') return b.kind !== 'other' || names(aText, b.who);
  if (b.kind === 'unknown') return a.kind !== 'other' || names(bText, a.who);
  if (a.kind === 'self') return b.kind === 'self' || names(aText, b.who);
  if (b.kind === 'self') return names(bText, a.who);
  return a.who === b.who || names(bText, a.who) || names(aText, b.who);
}

/**
 * The subjects an earlier extraction gave a detail of the person's own that
 * is now filed under `self.`: `self.city` was `person.user.city`,
 * `contact.owner.city` or `person.city`. Empty for any other subject.
 */
export function olderOwnSubjects(domainKey: string): string[] {
  if (!domainKey.startsWith('self.')) return [];
  const rest = domainKey.slice('self.'.length);
  return [...PERSON_HEADS].flatMap((head) => [
    `${head}.${rest}`,
    ...[...SELF].map((self) => `${head}.${self}.${rest}`),
  ]);
}
