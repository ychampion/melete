/**
 * Plain names for saved details, from their registry key or subject. Kept free
 * of other imports so every place that names a detail (the memory page, a
 * chat's work log, a room) can use it.
 */
const GENERIC_HEADS = new Set([
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
const PERSON_HEADS = new Set([
  'person',
  'people',
  'contact',
  'contacts',
  'family',
  'friend',
  'friends',
]);
/** Subjects that name the person themselves: their details read as "Your …", never "Owner's …". */
const SELF = new Set(['owner', 'user', 'me', 'self', 'you', 'myself']);
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
  const meaningful = GENERIC_HEADS.has(head.toLowerCase()) && rest.length ? rest : parts;
  return capitalize(meaningful.join(' ')).slice(0, 200);
}

/** How the person's family and circle are named in a subject: "sister", "landlord". */
const RELATIONS = new Set(
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
