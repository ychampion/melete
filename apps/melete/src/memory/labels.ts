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
    // "person.sam.brother.city" is Sam's brother's city.
    const [whose = '', ...theirs] = what;
    if (theirs.length && RELATIONS.has(whose.toLowerCase().split(' ')[0] ?? ''))
      return `${who}'s ${whose}'s ${theirs.join(' ')}`.slice(0, 200);
    return (what.length ? `${who}'s ${what.join(' ')}` : who).slice(0, 200);
  }
  // A detail filed under the person alone, with no topic, is about them.
  if (head.toLowerCase() === 'self' && (!rest.length || rest[0]?.toLowerCase() === 'about'))
    return 'About you';
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
    'niece nephew girlfriend boyfriend fiance fiancee doctor dentist bro sis'
  ).split(' '),
);
/**
 * Relation words that are also said to anyone: "Thanks bro, Sam moved to
 * Faro". They relate someone to the person only as theirs ("my bro Sam",
 * "Sam, my sis"), and someone else only after their name ("Sam's bro").
 */
const SAID_TO_ANYONE = new Set(['bro', 'sis']);

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

/** Words a detail starts with that are not someone in the person's life: "User lives in Lisbon". */
const NO_ONE = new Set([
  ...SELF,
  ...GENERIC_HEADS,
  ...PERSON_HEADS,
  ...'i he she they it this that there here we who his her their its the a an'.split(' '),
]);
/** Words after someone a detail starts with that say what they are, do or have: "Maya is", "Sam lives". */
const SAID_OF = new Set(
  (
    'is was has had lives lived works worked moved likes loves prefers wants needs owns eats ' +
    'drinks isn wasn hasn doesn'
  ).split(' '),
);
/** Words after "is" that say what a thing is to the person, never what someone is: "Coffee is a must". */
const THING_IS = new Set('must staple necessity nonnegotiable priority'.split(' '));
/**
 * Words after "is" that say it of a thing or a place when nothing more is
 * said of it: "Lisbon is home now", "Coffee is essential", but "Jo is home
 * for the holidays" and "Maya is essential to the team".
 */
const THING_IS_ALONE = new Set('home essential'.split(' '));
/** What may follow such a word and still say nothing more: "is home now", "is essential for me". */
const ALONE_AFTER = new Set('now for to me us these days here again'.split(' '));
/**
 * Words after "is" that say it of a thing when a thing follows: "Pizza is the
 * best food", but "Will is the best" and "Sam is the best at fixing bikes".
 */
const THING_IS_BEFORE = new Set('best favourite favorite'.split(' '));
/** Words after such a word that say what someone does, not which thing: "the best at", "the best to ask". */
const NO_THING_AFTER = new Set('at to of in for with on by i'.split(' '));
/**
 * Words for someone, which say a detail is about them however it starts:
 * "Sam is the best cook I know", "Maya is our favourite babysitter", "Max is
 * our dog".
 */
const SOMEONE_IS = new Set([
  ...RELATIONS,
  ...(
    'cook chef baker teacher babysitter nanny contact person guy girl boy man woman lady baby ' +
    'dog cat pet puppy mentor coach player driver nurse singer dancer writer student tutor ' +
    'therapist lawyer plumber mechanic accountant hairdresser barber teammate classmate buddy ' +
    'mate pal companion assistant client customer employee intern host'
  ).split(' '),
]);
/**
 * Words that start a detail of the person's own and are never a name: days,
 * parts of the day, meals, and everyday things ("Monday is gym day", "Dinner
 * is usually at 7", "Coffee's too bitter for me").
 */
const NEVER_SOMEONE = new Set(
  (
    'monday tuesday wednesday thursday friday saturday sunday weekend weekends weekday weekdays ' +
    'morning mornings evening evenings night nights today tonight tomorrow breakfast brunch ' +
    'lunch dinner supper coffee tea wine beer water milk juice sugar gluten dairy meat fish ' +
    'chocolate pizza sushi pasta rice bread cheese rent sleep gym yoga pilates football soccer ' +
    'tennis golf chess jazz school college university weather'
  ).split(' '),
);
/** Words between a verb and what it says that say nothing themselves: "is a must", "has been my hobby". */
const LEAD_IN = new Set(
  'a an the now still really so very always definitely also just been usually'.split(' '),
);
/** Words after a detail's first word that a thing says as often as someone does: "Coffee is". */
const EITHER = new Set('is was has had'.split(' '));
/** Words that put the person after what a detail starts with: "makes me sneeze", "is my main language". */
const THE_PERSON = new Set('me my us our'.split(' '));
/**
 * Whether a detail that starts with a capitalized word and "is", "has" or
 * "'s" is about a thing, a place or a pastime of the person's, not someone:
 * "Coffee is a must", "Monday is gym day", "Gardening is how I relax",
 * "Lisbon is home now", "Python is my main language", "Maya's cat makes me
 * sneeze". The capital may only start the sentence, so what is said decides,
 * and when it could be said of someone it is someone's: one that says who
 * they are to the person ("Maya is my favourite cousin"), what they are ("Sam
 * is the best cook I know"), where they are ("Jo is home for the holidays"),
 * or that names a detail of theirs ("Sam's diet is vegan").
 */
function thingFirst(words: readonly string[], at: number): boolean {
  const plain = (index: number) => (words[index] ?? '').replace(/['’]s$/u, '').toLowerCase();
  const first = plain(at);
  const neverSomeone = NEVER_SOMEONE.has(first) || /^\p{L}{3,}ing$/u.test(first);
  let verb = at + 1;
  if (/['’]s$/u.test(words[at] ?? '')) {
    if (TOPICS.has(plain(verb))) return false;
    if (neverSomeone) return true;
    verb++;
    // What is theirs does something to the person.
    if (THE_PERSON.has(plain(verb + 1)) && !SOMEONE_IS.has(plain(verb + 2))) return true;
  }
  if (neverSomeone) return true;
  if (!EITHER.has(plain(verb))) return false;
  let said = verb + 1;
  while (LEAD_IN.has(plain(said))) said++;
  for (let index = said; index < said + 6; index++) if (SOMEONE_IS.has(plain(index))) return false;
  const word = plain(said);
  if (THING_IS.has(word)) return true;
  if (THING_IS_ALONE.has(word))
    return words.slice(said + 1).every((_, index) => ALONE_AFTER.has(plain(said + 1 + index)));
  if (THING_IS_BEFORE.has(word)) {
    const next = plain(said + 1);
    return Boolean(next) && !NO_THING_AFTER.has(next);
  }
  return THE_PERSON.has(word);
}
/**
 * Who a detail's words are about, when they start with someone: "Maya is
 * allergic to peanuts", "Sam's diet is vegan", "My sister lives in Lisbon",
 * "Sister Maya is vegetarian", "my friend sam is vegetarian". Null when they
 * start with the detail itself ("Allergic to peanuts", "Will be away until
 * Friday"), with the person ("User lives in Lisbon"), or with a thing or a
 * place of theirs ("Coffee is a must", see `thingFirst`). A name on its own
 * is read only when written with a capital; after a relation, however
 * written.
 */
export function someoneFirst(text: string): { name?: string; relation?: string } | null {
  const words = text
    .trim()
    .split(/[^\p{L}\p{N}'’]+/u)
    .filter(Boolean);
  const plain = (word = '') => word.replace(/['’]s$/u, '').toLowerCase();
  const possessive = (word = '') => /['’]s$/u.test(word);
  let at = /^(?:my|our|his|her|their|the)$/i.test(words[0] ?? '') ? 1 : 0;
  let relation: string | undefined;
  if (RELATIONS.has(plain(words[at]))) {
    relation = plain(words[at]);
    if (possessive(words[at])) return { relation };
    at++;
  }
  const word = words[at] ?? '';
  const name = plain(word);
  if (
    name &&
    !NO_ONE.has(name) &&
    !TOPICS.has(name) &&
    !RELATIONS.has(name) &&
    !SAID_OF.has(name) &&
    (relation || /^\p{Lu}/u.test(word)) &&
    (possessive(word) || SAID_OF.has(plain(words[at + 1])))
  ) {
    if (!relation && thingFirst(words, at)) return null;
    return { name, ...(relation ? { relation } : {}) };
  }
  if (relation && SAID_OF.has(plain(words[at]))) return { relation };
  return null;
}

/**
 * Whose detail a subject holds, read from its heading. A name is read as one
 * however it is written: "sam" in "my friend sam" is someone, not a topic.
 * "Owner" is the person themself, unless the detail's own words say it is the
 * owner of something. A subject that names only a topic is someone's when
 * the detail's words start with them ("Maya is allergic to peanuts" under
 * person.allergy).
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
  if (!who || (!RELATIONS.has(subject) && textWords(who).every((word) => TOPICS.has(word)))) {
    const someone = content ? someoneFirst(content) : null;
    if (someone?.relation && someone.name)
      return {
        kind: 'other',
        who: someone.relation,
        name: someone.name,
        relation: someone.relation,
      };
    if (someone?.relation)
      return { kind: 'other', who: someone.relation, relation: someone.relation };
    if (someone?.name) return { kind: 'other', who: someone.name };
    return { kind: 'unknown', who };
  }
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
  bro: 'brother',
  sis: 'sister',
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
/** Words that may stand between a relation and a name and still describe them: "my good friend Sam". */
const DESCRIBING = new Set(
  'good best old older oldest young younger youngest little big baby dear close new great'.split(
    ' ',
  ),
);
const kinOf = (word: string) => word.split('-').some((part) => RELATIONS.has(part));
const isRelationWord = (word: string) => RELATIONS.has(word) || (word.includes('-') && kinOf(word));
/** A text's words, lowercased, as relations and names are read from them. */
const relationWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’-]+/u)
    // A hyphenated relation stays one word; any other ("Jean-Luc") is read word by word.
    .flatMap((word) => (word.includes('-') && kinOf(word) ? [word] : word.split('-')))
    .filter(Boolean);
/** A word without its "'s": "sam's" is "sam". */
const bareWord = (word: string) => word.replace(/['’]s?$/u, '');
/** A text's word as a name is matched to it: "o'brien's" is "obrien". */
const nameWord = (word: string) => bareWord(word).replace(/['’]/gu, '');
/**
 * A name's words as a text's words are matched to them. A name with an
 * apostrophe is one word however a subject wrote it: "O'Brien", "o_brien"
 * and "obrien" are all "obrien". One that starts with an initial is also
 * read word by word, so "d_smith" is still "D Smith".
 */
const nameForms = (name: string): string[][] => {
  const apart = textWords(name.replace(/['’]/gu, ''));
  const joined = textWords(name.replace(/['’]/gu, '').replace(/^([dlo])[\s_-]+(?=\p{L})/iu, '$1'));
  return joined.length === apart.length ? [apart] : [joined, apart];
};
/** The form of a name a text's word ends, if it ends one: "o'brien's" ends "obrien". */
const nameEnding = (forms: readonly string[][], word: string) =>
  forms.find((form) => form.length > 0 && form.at(-1) === nameWord(word));
/**
 * How a text relates the person to someone it names: "Brother Sam", "my
 * friend Sam", "Sam, my colleague". A relation of theirs ("Sam's sister")
 * is not one, nor is a relation of someone else's ("my friend's brother
 * Sam"). A relation by marriage or a former one ("brother-in-law",
 * "ex-boyfriend") is one of its own, not a brother or a partner. `beside`
 * reads a relation before the name only when nothing but describing words
 * stand between them, as in a sentence the person said: "My friend told me
 * Sam moved" says how they heard it, not who Sam is.
 */
export function relationsIn(text: string, name: string, beside = false): Set<string> {
  const found = new Set<string>();
  const words = relationWords(text);
  const possessive = (word: string) =>
    /['’]s$/u.test(word) && !CONTRACTED.has(word.replace('’', "'"));
  const forms = nameForms(name);
  const own = new Set(['my', 'your', 'a', 'an', 'the', 'our']);
  // "My little bro Sam", not "Thanks bro, Sam moved".
  const owned = (at: number) => {
    let back = at - 1;
    while (DESCRIBING.has(words[back] ?? '')) back--;
    return own.has(words[back] ?? '');
  };
  words.forEach((word, index) => {
    const who = nameEnding(forms, word);
    if (!who) return;
    for (let back = index - who.length; back >= Math.max(0, index - who.length - 3); back--) {
      const before = words[back] ?? '';
      if (possessive(before)) break;
      // "My friend's brother Sam" is the friend's brother.
      if (
        isRelationWord(before) &&
        !possessive(words[back - 1] ?? '') &&
        (!SAID_TO_ANYONE.has(before) || owned(back))
      )
        found.add(relation(before));
      else if (beside && !DESCRIBING.has(before)) break;
    }
    // "Sam's sister" is Sam's relation, not the person's.
    if (possessive(word)) return;
    const after = words.slice(index + 1, index + 4);
    const at = after.findIndex(isRelationWord);
    if (
      at >= 0 &&
      after.slice(0, at).every((item) => own.has(item)) &&
      at <= 1 &&
      (!SAID_TO_ANYONE.has(after[at] ?? '') || at === 1)
    )
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
/** Whether a detail's words, or its subject, say how the person knows the someone it is about. */
export const saysRelation = (whose: Whose, text: string) => relationsOf(whose, text).size > 0;
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
 * The relative of someone's a text is about, when it names them only as that
 * relative's: "Sam's brother moved to Faro" and "My friend Sam's older
 * brother moved to Faro" are about Sam's brother, "Sam's mom lives in Faro"
 * about his mother. Null when it names them any other way: "My brother Sam
 * moved to Faro", "Sam (my brother) moved", "Sam's flat is in Faro"; and
 * "Sams' brother" is not Sam's, though "James' brother" is James's.
 */
export function relativeOf(text: string, name: string): string | null {
  const words = relationWords(text);
  const forms = nameForms(name);
  let found: string | null = null;
  for (const [index, word] of words.entries()) {
    if (!nameEnding(forms, word)) continue;
    if (!/['’]s$/u.test(word) && !(nameWord(word).endsWith('s') && /['’]$/u.test(word)))
      return null;
    let next = index + 1;
    while (DESCRIBING.has(words[next] ?? '')) next++;
    // "Sam's brother's flat" is still his brother's.
    const kin = (words[next] ?? '').replace(/['’]s$/u, '');
    if (!isRelationWord(kin)) return null;
    found ??= relation(kin);
  }
  return found;
}
/** Words for anyone at all: "Everyone's friend Sam" is no one's in particular. */
const ANYONE = new Set('everyone everybody someone somebody anyone anybody nobody'.split(' '));
/**
 * Whose relative a text names someone as, when it names them only so: "Alex's
 * brother Sam moved to Faro" and "My friend Alex's older brother Sam moved to
 * Faro" are about Alex's brother, named Sam. Null when it names them any
 * other way ("My brother Sam", "Sam's brother"), or as the relative of one of
 * the person's own, who has no name to keep them under ("My friend's brother
 * Sam", "Mom's brother Sam").
 */
export function relativeNamed(text: string, name: string): { of: string; relative: string } | null {
  const words = relationWords(text);
  const forms = nameForms(name);
  let found: { of: string; relative: string } | null = null;
  for (const [index, word] of words.entries()) {
    const who = nameEnding(forms, word);
    if (!who) continue;
    // "Alex's brother Sam's wife" is about Sam's wife.
    let next = index + 1;
    while (DESCRIBING.has(words[next] ?? '')) next++;
    if (/['’]s$/u.test(word) && isRelationWord((words[next] ?? '').replace(/['’]s$/u, '')))
      return null;
    let at = index - who.length;
    const kin = words[at] ?? '';
    if (!isRelationWord(kin)) return null;
    at--;
    while (DESCRIBING.has(words[at] ?? '')) at--;
    const owner = words[at] ?? '';
    const of = nameWord(owner);
    const theirs =
      (/['’]s$/u.test(owner) && !CONTRACTED.has(owner.replace('’', "'"))) ||
      (of.endsWith('s') && /['’]$/u.test(owner));
    if (
      !theirs ||
      !of ||
      of === who.at(-1) ||
      isRelationWord(of) ||
      NO_ONE.has(of) ||
      ANYONE.has(of)
    )
      return null;
    if (found && found.of !== of) return null;
    found ??= { of, relative: relation(kin) };
  }
  return found;
}
/** Whether a text names someone at all, as themself or as whose something is: "Sam", "Sam's". */
export function namesIn(text: string, name: string): boolean {
  const forms = nameForms(name);
  return relationWords(text).some((word) => nameEnding(forms, word));
}
/**
 * The name a text gives someone's relative, written as a name is: "Alex's
 * brother Sam lives in Faro" names Alex's brother Sam. Null when it gives none
 * ("Alex's brother lives in Faro").
 */
export function relativeName(text: string, of: string): string | null {
  const words = relationWords(text);
  const forms = nameForms(of);
  const written = capitalized(text);
  for (const [index, word] of words.entries()) {
    if (!nameEnding(forms, word) || !/['’]s?$/u.test(word)) continue;
    let next = index + 1;
    while (DESCRIBING.has(words[next] ?? '')) next++;
    if (!isRelationWord(words[next] ?? '')) continue;
    const named = nameWord(words[next + 1] ?? '');
    if (named && written.has(named) && !RELATIONS.has(named) && !NO_ONE.has(named)) return named;
  }
  return null;
}
/**
 * The subject of someone's own detail, for one held as their relative's:
 * "person.sam.brother.city" is "person.sam.city" for Sam himself, and
 * "person.brother.sam.city" when the person's words say Sam is their brother.
 * For the relative a subject names someone's, `named` by the held words, it
 * is that relative's own: "person.alex.brother.city" is
 * "person.brother.sam.city" for Brother Sam, where it held Alex's brother Sam.
 */
export function themselfSubject(
  domainKey: string,
  name: string,
  related?: string,
  named?: string,
): string {
  const parts = withoutMember(domainKey).split('.');
  const at = parts.findIndex((part, index) => index > 0 && part.replace(/[_-]+/g, ' ') === name);
  if (at < 0) return withoutMember(domainKey);
  const lead = related ? [related] : parts.slice(1, at);
  return [parts[0], ...lead, named ?? parts[at], ...parts.slice(at + 2)].join('.');
}
/** The relative a subject names after someone's name: "person.sam.brother.city" is Sam's brother's. */
export function subjectRelative(domainKey: string, name: string): string | null {
  const parts = withoutMember(domainKey).split('.');
  const at = parts.findIndex((part, index) => index > 0 && part.replace(/[_-]+/g, ' ') === name);
  const next = at > 0 ? (parts[at + 1] ?? '') : '';
  return isRelationWord(next) ? relation(next) : null;
}
/**
 * The subject a detail about someone's relative is kept under: "person.sam.city"
 * for Sam's brother is "person.sam.brother.city", and
 * "person.friend.sam.brother.city" when the person's words say Sam is a friend.
 * Someone else's relative of that name is kept under whose relative they are,
 * `of`: "person.sam.city" for Alex's brother Sam is "person.alex.brother.city".
 */
export function relativeSubject(
  domainKey: string,
  name: string,
  relative: string,
  related?: string,
  of = name,
): string {
  const parts = withoutMember(domainKey).split('.');
  const at = parts.findIndex((part, index) => index > 0 && part.replace(/[_-]+/g, ' ') === name);
  let rest = at > 0 ? parts.slice(at + 1) : parts.slice(1);
  if (isRelationWord(rest[0] ?? '')) rest = rest.slice(1);
  return [parts[0], ...(related ? [related] : []), of.replace(/\s+/g, '_'), relative, ...rest].join(
    '.',
  );
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

/**
 * Subjects that name one detail of the person's own: the city they live in is
 * home.city, or self.city and self.home.city when it was filed under the
 * person (person.user.city). Where they work, or anything else that also says
 * "city", is another detail.
 */
const ONE_OWN_DETAIL: readonly (readonly string[])[] = [
  ['home.city', 'self.city', 'self.home.city'],
];
/** The other subjects that name the same detail of the person's own (see `ONE_OWN_DETAIL`). */
export function sameOwnDetail(domainKey: string): string[] {
  const names = ONE_OWN_DETAIL.find((group) => group.includes(domainKey));
  return names ? names.filter((name) => name !== domainKey) : [];
}

/** Words that say a detail is over, not how things are now: "Used to live in Lisbon", "Grew up in Porto". */
const OVER =
  /\b(?:used to|grew up|formerly|previously|no longer|anymore|lived|was born|born in)\b/iu;
/**
 * Whether a detail says how things are for the person now, so another name
 * for it may hold it (see `sameOwnDetail`): not a detail of the past, nor one
 * that starts with someone ("Mom lives in Porto").
 */
export function ownDetailNow(proposal: { kind: string; content: string }): boolean {
  return (
    proposal.kind !== 'historical' &&
    !OVER.test(proposal.content) &&
    someoneFirst(proposal.content) === null
  );
}

/**
 * Whether a subject holds a detail of the person's own filed under them
 * alone, with no topic: self.about.night_work, or "self" as an older
 * extraction filed it.
 */
export const aboutThem = (domainKey: string) => {
  const subject = withoutMember(domainKey);
  return subject === 'self' || subject === 'self.about' || subject.startsWith('self.about.');
};

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
