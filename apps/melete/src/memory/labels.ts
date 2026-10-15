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

/**
 * The part of a subject that keeps one room member's detail apart from
 * another's held under the same subject (see `memberSubject`).
 */
const MEMBER_PART = /^member_[0-9a-f]{12}$/;
/** A subject without the part that says which room member's detail it is. */
export const withoutMember = (subject: string) => {
  const [base = '', ...exception] = subject.split(':exception:');
  const parts = base.split('.').filter((part) => !MEMBER_PART.test(part));
  return [parts.join('.'), ...exception].join(':exception:');
};
/**
 * The subject a room member's detail is kept under when another member's
 * detail already holds the subject it was proposed under: two members who are
 * both allergic to peanuts keep two details, each resting on its own words.
 */
export function memberSubject(domainKey: string, member: string): string {
  return `${withoutMember(domainKey)}.member_${member.slice(0, 12)}`;
}

/** A plain name for what a belief is about, from its registry key or its subject. */
export function subjectLabel(plainKey: string | null, plainDomain: string): string {
  // Which room member a detail is kept apart for is not part of its name.
  const key = plainKey && withoutMember(plainKey);
  const domainKey = withoutMember(plainDomain);
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
export const TOPICS = new Set([
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
  /** Someone, by the subject's word for them, with their name and relation when it gives both. */
  | { kind: 'other'; who: string; name?: string; relation?: string }
  | { kind: 'unknown'; who: string };

const textWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
/**
 * Words that start a sentence often, and are also someone's name: "Will be
 * away until Friday", "May be late on Mondays". At the start of a sentence
 * they name someone only when what follows says so (see `namedAtStart`).
 */
const STARTERS = new Set(
  (
    'will may can could would should might must shall do does did is are was were be have has ' +
    'had mark bill pat sue rob grant chase hope frank'
  ).split(' '),
);
/** Words after a name that say it is one: "Will is", "May from accounting", "Will's". */
const NAME_FOLLOWERS = new Set(
  (
    'is was has had and or from said says told asked lives lived works worked moved likes loves ' +
    'prefers wants needs owns runs called can cannot will won may might should would could ' +
    'did didn doesn does isn wasn hasn'
  ).split(' '),
);
/** Words that end like "lives" or "works" but say nothing of a name before them. */
const NOT_VERBS = new Set(
  'always sometimes perhaps unless us this his its yes plus thus as across towards afterwards less'.split(
    ' ',
  ),
);
/**
 * Whether a capitalized word at the start of a sentence is a name there:
 * "Will is away", "May from accounting", "Will's birthday", "Will, my
 * colleague"; not "Will be away" or "May be late".
 */
function namedAtStart(word: string, next: string | undefined, apart: string): boolean {
  if (!STARTERS.has(word.toLowerCase())) return true;
  if (/^['’]s$/u.test(next ?? '') || apart.includes(',')) return true;
  const after = (next ?? '').toLowerCase();
  return (
    NAME_FOLLOWERS.has(after) || (after.length > 3 && after.endsWith('s') && !NOT_VERBS.has(after))
  );
}
/**
 * The words a text writes with a capital, as names are written. A word that
 * only starts a sentence, and is one people start sentences with, is not
 * read as a name unless what follows says it is one.
 */
const capitalized = (text: string) => {
  const said = new Set<string>();
  const parts = text.split(/([^\p{L}\p{N}]+)/u);
  let start = true;
  for (let index = 0; index < parts.length; index += 2) {
    const word = parts[index] ?? '';
    const apart = parts[index + 1] ?? '';
    if (word) {
      if (/^\p{Lu}/u.test(word)) {
        // "Will's" is split as "Will" and "s": the "'s" follows it.
        const next = /^['’]$/u.test(apart) ? `'${parts[index + 2] ?? ''}` : parts[index + 2];
        if (!start || namedAtStart(word, next, apart)) said.add(word.toLowerCase());
      }
      start = false;
    }
    if (/[.!?]/.test(apart)) start = true;
  }
  return said;
};
/**
 * Whether a text names someone: every word of the name is written in it, with
 * a capital ("Maya", "Mr. Patel"). A subject made of plain words, such as
 * "lives_in" for "Lives in Pune" or "diet" for "my diet", names nobody; nor
 * does a sentence that starts "Will be …" or "May be …".
 */
function names(text: string, who: string): boolean {
  const said = capitalized(text);
  const name = textWords(who);
  return name.length > 0 && name.every((word) => said.has(word));
}

/**
 * A subject an older extraction gave one of the person's own details as one
 * run of words under a person heading, such as "person.peanut_allergy": a
 * word of it says what kind of detail it is ("allergy"), and the sentence it
 * is compared with names no one by its other words. Read alone, as
 * `whoseDetail` reads it, it would be someone called "peanut allergy".
 */
export function ownTopicRun(domainKey: string, text: string): boolean {
  const [head = '', run = '', ...rest] = domainKey.split('.');
  if (rest.length || !PERSON_HEADS.has(head)) return false;
  const words = textWords(run);
  if (words.length < 2 || !words.some((word) => TOPICS.has(word))) return false;
  return words.every((word) => TOPICS.has(word) || !names(text, word));
}

/**
 * Whether a detail saved under "owner" is about the owner of something,
 * someone else: "The owner of my flat lives upstairs", "The café owner's
 * number". The person themself is the owner of their memory, and older
 * details about them were saved under "owner"; those say no such thing. Nor
 * does a detail of theirs that says what they own: "Owner of a café in Lisbon".
 */
const OWNER_OF_SOMETHING =
  /\bthe\s+owners?(?:['’]s)?\s+of\b|\bowners?(?:['’]s)?\s+of\s+(?:my|your|our|the)\b|\b(?:flat|house|home|apartment|building|property|shop|store|caf[eé]|restaurant|bar|business|company|venue|hotel|car|dog|cat|land)(?:['’]s)?\s+owners?\b/i;

/**
 * Whose detail a subject holds, read from its heading. A name is read as one
 * however it is written: "sam" in "my friend sam" is someone, not a topic.
 * "Owner" is the person themself, unless the detail's own words say it is the
 * owner of something.
 */
export function whoseDetail(plainKey: string, content?: string | null): Whose {
  const domainKey = withoutMember(plainKey);
  const parts = (domainKey.split(':exception:')[0] ?? domainKey).split('.');
  const [head = '', subject = '', next = ''] = parts;
  if (!PERSON_HEADS.has(head)) return { kind: 'self' };
  if (subject === 'owner' && content && OWNER_OF_SOMETHING.test(content))
    return { kind: 'other', who: 'owner' };
  if (SELF.has(subject)) return { kind: 'self' };
  const who = subject.replace(/[_-]+/g, ' ').trim();
  if (!who || (!RELATIONS.has(subject) && textWords(who).every((word) => TOPICS.has(word))))
    return { kind: 'unknown', who };
  // "person.brother.sam.city" is Brother Sam; "person.sister.city" is the sister's city.
  const name = next.replace(/[_-]+/g, ' ').trim();
  if (RELATIONS.has(subject) && name && !textWords(name).every((word) => TOPICS.has(word)))
    return { kind: 'other', who, name, relation: subject };
  return { kind: 'other', who, ...(RELATIONS.has(subject) ? { relation: subject } : {}) };
}

/** Relations that name the same one in other words. */
const SAME_RELATION: Record<string, string> = {
  mom: 'mother',
  mum: 'mother',
  dad: 'father',
  grandma: 'grandmother',
  grandpa: 'grandfather',
  coworker: 'colleague',
  neighbour: 'neighbor',
  flatmate: 'roommate',
  landlady: 'landlord',
  kid: 'child',
  fiancee: 'fiance',
  wife: 'partner',
  husband: 'partner',
  spouse: 'partner',
  girlfriend: 'partner',
  boyfriend: 'partner',
  fiance: 'partner',
};
/** Family, as relations: no one is both someone's brother and their friend or sister. */
const KIN: Record<string, string[]> = {
  sister: ['sibling'],
  brother: ['sibling'],
  mother: ['parent'],
  father: ['parent'],
  son: ['child'],
  daughter: ['child'],
  sibling: [],
  parent: [],
  child: [],
  cousin: [],
  aunt: [],
  uncle: [],
  grandmother: [],
  grandfather: [],
  niece: [],
  nephew: [],
};
/** Circles outside the family; someone may be in one only, a friend or partner in any. */
const CIRCLE: Record<string, string> = {
  colleague: 'work',
  boss: 'work',
  manager: 'work',
  neighbor: 'home',
  roommate: 'home',
  landlord: 'home',
  doctor: 'doctor',
  dentist: 'dentist',
};
const relation = (word: string) => SAME_RELATION[word] ?? word;
/** Whether one person can be both: "a friend" and "a colleague", but not "a brother" and "a friend". */
function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  const kinA = KIN[a];
  const kinB = KIN[b];
  if (kinA || kinB) return Boolean(kinA?.includes(b) || kinB?.includes(a));
  const circleA = CIRCLE[a];
  const circleB = CIRCLE[b];
  return !circleA || !circleB || circleA === circleB;
}
/** Words ending in "'s" that are no one's: "It's brother Sam's birthday". */
const CONTRACTED = new Set(
  "it's that's there's here's what's who's where's he's she's let's".split(' '),
);
/**
 * How a text relates the person to someone it names: "Brother Sam", "my
 * friend Sam", "Sam, my colleague". A relation of theirs ("Sam's sister")
 * is not one, nor is a relation of someone else's ("my friend's brother
 * Sam"). A relation by marriage or a former one ("brother-in-law",
 * "ex-boyfriend") is one of its own, not a brother or a partner.
 */
export function relationsIn(text: string, name: string): Set<string> {
  const found = new Set<string>();
  const kinOf = (word: string) => word.split('-').some((part) => RELATIONS.has(part));
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’-]+/u)
    // A hyphenated relation stays one word; any other ("Jean-Luc") is read word by word.
    .flatMap((word) => (word.includes('-') && kinOf(word) ? [word] : word.split('-')))
    .filter(Boolean);
  const isRelation = (word: string) => RELATIONS.has(word) || (word.includes('-') && kinOf(word));
  const possessive = (word: string) =>
    /['’]s$/u.test(word) && !CONTRACTED.has(word.replace('’', "'"));
  const who = textWords(name);
  const last = who.at(-1);
  if (!last) return found;
  const plain = (word: string) => word.replace(/['’]s?$/u, '');
  const own = new Set(['my', 'your', 'a', 'an', 'the', 'our']);
  words.forEach((word, index) => {
    if (plain(word) !== last) return;
    for (let back = index - who.length; back >= Math.max(0, index - who.length - 3); back--) {
      const before = words[back] ?? '';
      if (possessive(before)) break;
      // "My friend's brother Sam" is the friend's brother.
      if (isRelation(before) && !possessive(words[back - 1] ?? '')) found.add(relation(before));
    }
    // "Sam's sister" is Sam's relation, not the person's.
    if (possessive(word)) return;
    const after = words.slice(index + 1, index + 4);
    const at = after.findIndex(isRelation);
    if (at >= 0 && after.slice(0, at).every((item) => own.has(item)) && at <= 1)
      found.add(relation(after[at] ?? ''));
  });
  return found;
}
/** Every relation each detail gives someone: from its subject and its words. */
function relationsOf(whose: Whose, text: string): Set<string> {
  if (whose.kind !== 'other') return new Set();
  const found = whose.name || !whose.relation ? relationsIn(text, whose.name ?? whose.who) : null;
  const all = new Set(found ?? []);
  if (whose.relation) all.add(relation(whose.relation));
  return all;
}
/**
 * Whether two details about someone of the same name are about two people:
 * each says how the person knows them, and no relation of one could be the
 * other's ("Friend Sam" and "Brother Sam"; a colleague and a neighbour). A
 * detail that does not say, or says a relation both could have ("my friend
 * Sam" and "Sam, my colleague"), may be the same one.
 */
export function twoPeople(a: Whose, aText: string, b: Whose, bText: string): boolean {
  const left = relationsOf(a, aText);
  const right = relationsOf(b, bText);
  if (!left.size || !right.size) return false;
  return [...left].every((x) => [...right].every((y) => !compatible(x, y)));
}
/** The name a detail about someone gives them, without how they are related. */
export const nameOf = (whose: Whose) =>
  whose.kind === 'other' ? (whose.name ?? (whose.relation ? null : whose.who)) : null;
/**
 * The subject a detail about someone is kept under when someone else of the
 * same name holds its subject: "person.sam.city" for Brother Sam beside
 * Friend Sam is "person.brother.sam.city".
 */
export function relatedSubject(domainKey: string, whose: Whose, text: string): string | null {
  const name = nameOf(whose);
  if (!name) return null;
  const [found] = relationsIn(text, name);
  if (!found) return null;
  const parts = withoutMember(domainKey).split('.');
  const [head = '', subject = ''] = parts;
  const rest = RELATIONS.has(subject) ? parts.slice(2) : parts.slice(1);
  return [head, found, ...rest].join('.');
}

/**
 * Whether two details can be about the same one: both the person's own, or
 * the same someone (the same name, or one naming the other: "Sister Lena" is
 * person.lena and family.sister). The person's own detail and someone
 * else's never are, nor two different people's, however alike their words;
 * nor two people of one name the details relate differently ("Friend Sam"
 * and "Brother Sam"). A detail under a topic that names that someone is
 * theirs ("Priya owns the Atlas project" under project.atlas). A subject that
 * names a topic, not someone, may be the person's own.
 */
export function sameWhose(a: Whose, aText: string, b: Whose, bText: string): boolean {
  if (a.kind === 'unknown') return b.kind !== 'other' || names(aText, b.who);
  if (b.kind === 'unknown') return a.kind !== 'other' || names(bText, a.who);
  if (a.kind === 'self') return b.kind === 'self' || names(aText, nameOf(b) ?? b.who);
  if (b.kind === 'self') return names(bText, nameOf(a) ?? a.who);
  if (twoPeople(a, aText, b, bText)) return false;
  // "Sister Lena" and "Sister Maya" are two sisters.
  if (a.name !== undefined && b.name !== undefined && a.name !== b.name) return false;
  return (
    a.who === b.who ||
    (a.name !== undefined && a.name === nameOf(b)) ||
    (b.name !== undefined && b.name === nameOf(a)) ||
    names(bText, nameOf(a) ?? a.who) ||
    names(aText, nameOf(b) ?? b.who)
  );
}

/** A subject an older extraction gave a detail of the person's own: a person heading naming no one. */
export const olderOwnSubject = (domainKey: string) =>
  PERSON_HEADS.has(domainKey.split('.')[0] ?? '') && whoseDetail(domainKey).kind !== 'other';

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
