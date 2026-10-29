/**
 * "Show me only what needs me" (summaries.ts), held in code as well as in the
 * agent's instructions. In a room set to it, the people who may see only
 * summaries of its mail, events and files get them in two steps:
 *
 * - Upstream, what the model reads for such a person's request has the
 *   private details of those originals (who sent them, the addresses and
 *   numbers in them, the people they name, the medicine they mention) swapped
 *   for stable placeholders by role, such as "[doctor 1]" or "[phone number 2]".
 *   The model still reads dates, amounts, what kind of thing each item is and
 *   what it says, so it can still summarise. The placeholders are never put
 *   back, so nothing the model writes can carry the details.
 * - Downstream, the agent's answers, its cards and receipts, the board items it
 *   made and the live stream are checked before such a person reads them: any
 *   detail of the originals still in them (a name or address in any case, an
 *   identifier in any spelling, three or more words in a row from a subject, a
 *   long run of a message's words) is replaced by what it is ("the doctor", "a
 *   phone number"), and the request's receipts say how many were kept out.
 *
 * Both steps use the same list of details, read from the receipts of the
 * room's own reads of its mail, calendars and files. The room's maker, whose
 * accounts they are, reads everything as before.
 */
import { PRIVACY_CATEGORIES, type PrivacyCategory } from '@melete/contracts';
import { and, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { action, connection, job, owner, principal, space, spaceMembership } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { detect } from '../privacy/detect.ts';
import { type Protocol, Redactor } from '../privacy/redact.ts';
import { Vault } from '../privacy/vault.ts';
import { spacePolicy } from './schema.ts';

type Reader = Database | Transaction;

/** The steps that read a space's originals. Their receipts are where the details come from. */
export const ORIGINAL_READS = [
  'email.search',
  'email.read',
  'email.read_attachment',
  'calendar.list',
  'calendar.freebusy',
  'files.list',
  'files.read',
] as const;

/** What a detail is, as a placeholder and as the words that replace it. */
const ROLE_WORDS = {
  doctor: 'the doctor',
  dentist: 'the dentist',
  nurse: 'the nurse',
  pharmacist: 'the pharmacist',
  person: 'someone',
  sender: 'the sender',
  pharmacy: 'the pharmacy',
  clinic: 'the clinic',
  'dental office': 'the dental office',
  bank: 'the bank',
  'health plan': 'the health plan',
  utility: 'the utility',
  school: 'the school',
  company: 'the company',
  'email address': 'an email address',
  'phone number': 'a phone number',
  address: 'an address',
  'account number': 'an account number',
  'ID number': 'an ID number',
  'prescription number': 'a prescription number',
  medicine: 'a medicine',
  code: 'a code',
} as const;
export type DetailRole = keyof typeof ROLE_WORDS;

/** What a run of an original's own words is replaced by. */
const PHRASE_WORDS = { message: 'a message', event: 'an event', file: 'a file' } as const;
type PhraseKind = keyof typeof PHRASE_WORDS;
const QUOTE_WORDS = '(details kept back)';

/** How many words in a row of a message make a quote. */
export const QUOTE_RUN = 8;
/** How many words that say something (not "the", a number or a date) a subject run needs. */
export const SUBJECT_RUN = 3;

/** One person, organisation, address or identifier, in every spelling it was seen in. */
type Detail = {
  role: DetailRole;
  /** Its number among the details of its role, for the placeholder. */
  n: number;
  values: string[];
  /** Digits and letters match with any separators between them. */
  numeric: boolean;
  /** A title before it ("Dr.", "Ms") goes with it. */
  titled: boolean;
};

/** Everything a summaries-only reader may not read, from one space's originals. */
export type Originals = {
  details: Detail[];
  /** Subjects, event titles and file names, as words. */
  phrases: { words: string[]; kind: PhraseKind }[];
  /** Digests of every run of `QUOTE_RUN` words of the originals' text. */
  quotes: Set<number>;
};

export const EMPTY_ORIGINALS: Originals = { details: [], phrases: [], quotes: new Set() };

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Words too ordinary to be a detail on their own, though a name may use one. */
const COMMON = new Set(
  `a about above after again against all also am an and any are as at back be because been before being
  below between both but by call can card care change changes check close come could day days dear did do
  does done down due during each early end even every few find first for free from full get give go good
  great had has have he help her here him his home hope how i if in into is it its just keep kind last
  late let like little long look made make many may me more most much must my need new next no not note
  notice now of off office old on once one only open or other our out over own part pay people plan please
  plus point read ready real reminder right same say see send set she should show since so some soon still
  such sure take team than thank thanks that the their them then there these they this those through time
  to today too two under until up us use very want was way we week well were what when where which while
  who why will with would year yes yet you your
  account address advantage appointment balance bill billing center choice clinic community confirm
  confirmed cleaning customer date dental doctor health insurance letter mail medical member message
  monthly new order payment pharmacy prescription refill refills renewal senior service services statement
  summary support valley visit dose dosage tablet tablets capsule capsules daily twice total strength
  generic only each about
  april august bill bob cash chase dawn faith frank grace holly hunter iris ivy jack joy june lily mark
  march may pat rich rose ruby summer will`.split(/\s+/),
);

/** Words that say nothing on their own, for counting how much a run says. */
const FILLER = new Set(
  `a an and are as at be been by for from has have her his i if in is it its me my no not of on or our she
  so that the their them they this to was we were will with you your am pm`.split(/\s+/),
);
const MONTHS =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow)$/;
const says = (word: string) => !FILLER.has(word) && !/\d/.test(word) && !MONTHS.test(word);

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
type Token = { word: string; start: number; end: number };
function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0].toLowerCase().replace(/’/g, "'");
    // "Okafor’s" is Okafor: the possessive stays in the text when he is replaced.
    const possessive = /'s$/.test(word);
    found.push({
      word: possessive ? word.slice(0, -2) : word,
      start: match.index,
      end: match.index + match[0].length - (possessive ? 2 : 0),
    });
  }
  return found;
}

/** FNV-1a over a run of words. Collisions only ever hide words, never show them. */
function digest(words: readonly string[], from: number, count: number): number {
  let hash = 0x811c9dc5;
  for (let index = from; index < from + count; index++) {
    for (const char of words[index] ?? '') {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x20;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Reading the details out of the originals
// ---------------------------------------------------------------------------

const NAME_WORD = "[A-Z][\\p{Ll}'’-]+";
// Words of one name stay on one line: a signature's next line is not part of it.
const NAME = `${NAME_WORD}(?:[ \\t]+(?:[A-Z]\\.[ \\t]+)?${NAME_WORD}){0,2}`;
const TITLES: [RegExp, DetailRole][] = [
  [/^(?:dr|doctor)$/i, 'doctor'],
  [/^nurse$/i, 'nurse'],
  [/^(?:mr|mrs|ms|mx|miss|prof|professor|rev|pastor)$/i, 'person'],
];
const TITLE = '(?:Dr|Doctor|Mr|Mrs|Ms|Mx|Miss|Prof|Professor|Nurse|Rev|Pastor)';
const TITLED_NAME = new RegExp(`\\b(${TITLE})\\.?[ \\t]+(${NAME})`, 'gu');
const CREDENTIALS: [RegExp, DetailRole][] = [
  [/^(?:MD|M\.D\.|DO)$/, 'doctor'],
  [/^(?:DDS|DMD)$/, 'dentist'],
  [/^(?:RN|NP|PA-C)$/, 'nurse'],
  [/^PharmD$/, 'pharmacist'],
];
const CREDENTIAL_NAME = new RegExp(
  `\\b(${NAME_WORD}(?:[ \\t]+[A-Z]\\.)?(?:[ \\t]+${NAME_WORD}){1,2}),?[ \\t]+(MD|M\\.D\\.|DO|DDS|DMD|RN|NP|PA-C|PharmD)\\b`,
  'gu',
);
const LABELS: [string, DetailRole][] = [
  ['prescriber', 'doctor'],
  ['prescribed by', 'doctor'],
  ['physician', 'doctor'],
  ['provider', 'doctor'],
  ['dentist', 'dentist'],
  ['hygienist', 'dentist'],
  ['pharmacist', 'pharmacist'],
  ['nurse', 'nurse'],
  ['caseworker', 'person'],
  ['contact', 'person'],
  ['attn', 'person'],
  ['attention', 'person'],
  ['regards', 'person'],
  ['sincerely', 'person'],
  ['thanks', 'person'],
];
const capitalised = (word: string) =>
  word
    .split(' ')
    .map((part) => `[${part[0]?.toUpperCase()}${part[0]}]${part.slice(1)}`)
    .join('\\s+');
const LABELLED_NAME = new RegExp(
  `\\b(${LABELS.map(([label]) => capitalised(label)).join('|')})[:,]?[ \\t]*\\n?[ \\t]*(${NAME_WORD}(?:[ \\t]+${NAME_WORD}){1,2})`,
  'gu',
);

/** Kinds of organisation a sender's name says it is, checked in order. */
const ORGANISATIONS: [RegExp, DetailRole][] = [
  [/\bpharmac/i, 'pharmacy'],
  [/\b(?:dental|dentist|orthodont)/i, 'dental office'],
  [/\b(?:clinic|medical|hospital|physicians?|surgery|health ?care|care center)\b/i, 'clinic'],
  [/\b(?:bank|credit union|savings|financial|card services)\b/i, 'bank'],
  [/\b(?:insurance|health plans?|medicare|medicaid|advantage|hmo|ppo)\b/i, 'health plan'],
  [/\b(?:energy|power|electric|gas|water|utilit\w*|telecom|wireless)\b/i, 'utility'],
  [/\b(?:school|academy|district|college|university)\b/i, 'school'],
  [
    /\b(?:inc|llc|ltd|co|corp|company|services|support|billing|team|notifications?|no-?reply)\b/i,
    'company',
  ],
];

/** Words that end an organisation's name; what comes before them is its own name. */
const ORGANISATION_WORDS =
  'Pharmacy|Pharmacies|Dental|Dentistry|Clinic|Medical|Medicine|Hospital|Health|Healthcare|Care|Plans?|Insurance|Bank|Credit|Savings|Financial|Energy|Power|Electric|Gas|Water|Utilities|School|Academy|District|College|University|Inc|LLC|Ltd|Co|Corp|Company|Services?|Support|Billing|Team|Family|Center|Centre|Group|Associates|Partners|Practice|Office';
const ORGANISATION_WORD = new RegExp(`^(?:${ORGANISATION_WORDS})\\.?$`, 'i');
/**
 * A capitalised name ending in a word that says it is a practice or a bank,
 * as a message's text names a clinic ("Larkspur Family Medicine").
 */
const ORGANISATION_NAME =
  /\b((?:[A-Z][\p{L}'’-]+[ \t]+){1,4}(?:Pharmacy|Clinic|Medicine|Medical|Hospital|Dental|Dentistry|Bank|Insurance|Practice|Associates))\b/gu;
/** Words that start many organisations' names and name none of them. */
const GENERIC_HEADS = new Set(
  `primary urgent mental family customer internal general community emergency public national local
  federal state city county social security patient specialty retail online central main north south
  east west united american first`.split(/\s+/),
);

const MEDICINE =
  /\b([A-Za-z][a-z]{3,}(?:[ -][A-Za-z][a-z]{3,})?)\s+\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ml|mL|units?|IU)\b/g;
/** Numbers that only an original carries: references, short phone numbers, grouped digits. */
const IDENTIFIERS: [RegExp, DetailRole][] = [
  [/\(\d{3}\)\s?\d{3}[-.\s]\d{4}\b/g, 'phone number'],
  [/(?<![\d$.,:/-])\d{3}[-.]\d{4}(?![\d.,:/-]?\d)/g, 'phone number'],
  // A reference of letters and at least four digits in dashed groups (not "COVID-19").
  [/\b(?=(?:[A-Z-]*\d){4})(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){1,4}\b/g, 'ID number'],
  [/(?<![\d$.,:/-])\d{4}(?:[ -]\d{4}){2,3}(?![\d.,:/-]?\d)/g, 'account number'],
  [/(?<![\d$.,:/-])\d{6,}(?![\d.,:/-]?\d)/g, 'ID number'],
];
const DATE_LIKE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})$/;

const CATEGORY_ROLE: Partial<Record<PrivacyCategory, DetailRole>> = {
  account: 'account number',
  card: 'account number',
  routing: 'account number',
  ssn: 'ID number',
  tax_id: 'ID number',
  national_id: 'ID number',
  passport: 'ID number',
  license: 'ID number',
  health: 'ID number',
  address: 'address',
  phone: 'phone number',
  email: 'email address',
  credential: 'code',
  name: 'person',
  private: 'ID number',
};
const ALL_CATEGORIES = new Set<PrivacyCategory>(PRIVACY_CATEGORIES.filter((c) => c !== 'dob'));
const NUMERIC_ROLES = new Set<DetailRole>([
  'phone number',
  'account number',
  'ID number',
  'prescription number',
]);

/** Fields of a read's receipt that name who a message or event is from or to. */
const PEOPLE_FIELDS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply_to',
  'sender',
  'organizer',
  'attendees',
  'from_addresses',
  'to_addresses',
]);
const SENDING_FIELDS = new Set(['from', 'sender', 'organizer', 'from_addresses', 'reply_to']);
/** Fields that are an original's own title. */
const TITLE_FIELDS: Record<string, PhraseKind> = {
  subject: 'message',
  summary: 'event',
  title: 'event',
  name: 'file',
  filename: 'file',
};
/** Fields that are an original's own words. */
const TEXT_FIELDS = new Set([
  'text',
  'body',
  'description',
  'location',
  'snippet',
  'notes',
  'content',
]);

const LIMITS = { details: 4000, phrases: 2000, quotes: 400_000 };

/** The people of the room, by name and address: they are never details of its originals. */
export type RoomPeople = { names: string[]; addresses: string[] };

class Harvest {
  private readonly details: Detail[] = [];
  private readonly byValue = new Map<string, Detail>();
  private readonly counters = new Map<DetailRole, number>();
  private readonly phrases: Originals['phrases'] = [];
  private readonly seenPhrases = new Set<string>();
  private readonly quotes = new Set<number>();
  private readonly peopleWords: Set<string>;
  private readonly peopleAddresses: Set<string>;

  constructor(people: RoomPeople) {
    this.peopleAddresses = new Set(people.addresses.map((address) => address.trim().toLowerCase()));
    this.peopleWords = new Set(
      people.names.flatMap((name) => tokens(name).map((token) => token.word)),
    );
  }

  /** What has been harvested so far: a new value each time, since more may be added. */
  result(): Originals {
    return { details: [...this.details], phrases: [...this.phrases], quotes: this.quotes };
  }

  /** Whether a word belongs to someone in the room. */
  private ours(value: string) {
    return tokens(value).some((token) => this.peopleWords.has(token.word));
  }

  private add(role: DetailRole, values: string[], titled = false) {
    const usable = [
      ...new Set(values.map((value) => value.trim().replace(/\s+/g, ' ')).filter(Boolean)),
    ].filter((value) => value.length >= 3);
    if (!usable.length || this.details.length >= LIMITS.details) return;
    const known = usable.map((value) => this.byValue.get(value.toLowerCase())).find(Boolean);
    if (known) {
      for (const value of usable)
        if (!this.byValue.has(value.toLowerCase())) {
          known.values.push(value);
          this.byValue.set(value.toLowerCase(), known);
        }
      // A sender first seen by name is a doctor once a title says so.
      if (known.role === 'person' && role !== 'person' && !NUMERIC_ROLES.has(role)) {
        known.role = role;
        known.n = this.next(role);
      }
      return;
    }
    const detail: Detail = {
      role,
      n: this.next(role),
      values: usable,
      numeric: NUMERIC_ROLES.has(role),
      titled,
    };
    this.details.push(detail);
    for (const value of usable) this.byValue.set(value.toLowerCase(), detail);
  }

  private next(role: DetailRole) {
    const n = (this.counters.get(role) ?? 0) + 1;
    this.counters.set(role, n);
    return n;
  }

  /** A person by name: the whole name, and each part of it that is not an ordinary word. */
  private person(name: string, role: DetailRole) {
    if (this.ours(name)) return;
    const parts = name.split(/\s+/).filter((part) => !/^[A-Z]\.$/.test(part));
    const whole = parts.join(' ');
    const own = parts.filter((part) => part.length >= 3 && !COMMON.has(part.toLowerCase()));
    // "Customer Service" after "Contact" is not anyone's name.
    if (!own.length) return;
    this.add(role, [whole, ...(parts.length > 1 ? own : [])], true);
  }

  /** "Name <address>", a bare address, or a list of either. */
  identities(value: string, sending: boolean) {
    for (const piece of value.split(/[,;](?![^<]*>)/)) {
      const address =
        /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(piece)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(piece)?.[0];
      if (address && this.peopleAddresses.has(address.toLowerCase())) continue;
      const name = piece
        .replace(/<[^>]*>/g, '')
        .replace(address ?? '\u0000', '')
        .replace(/["'()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (address) this.add('email address', [address]);
      if (name && !name.includes('@')) this.named(name, sending);
    }
  }

  /** A display name: a titled person, an organisation, or a person. */
  private named(name: string, sending: boolean) {
    if (this.ours(name)) return;
    const titled = new RegExp(`^(${TITLE})\\.?\\s+(.+)$`, 'u').exec(name);
    if (titled?.[1] && titled[2]) {
      this.person(
        titled[2],
        TITLES.find(([pattern]) => pattern.test(titled[1] ?? ''))?.[1] ?? 'person',
      );
      return;
    }
    const kind =
      ORGANISATIONS.find(([pattern]) => pattern.test(name))?.[1] ??
      (name.split(/\s+/).some((word) => ORGANISATION_WORD.test(word)) ? 'company' : undefined);
    if (kind) {
      this.organisation(name, kind);
      return;
    }
    const looksLikeAPerson =
      /^[A-Z][\p{Ll}'’-]+(?:\s+(?:[A-Z]\.\s+)?[A-Z][\p{Ll}'’-]+){1,2}$/u.test(name);
    if (looksLikeAPerson) this.person(name, 'person');
    else if (name.length >= 3 && !COMMON.has(name.toLowerCase()))
      this.add(sending ? 'sender' : 'person', [name]);
  }

  /** An organisation by name: the whole name, and the words before what kind it is. */
  private organisation(name: string, kind: DetailRole, named = false) {
    const words = name.split(/\s+/);
    const at = words.findIndex((word) => ORGANISATION_WORD.test(word));
    const head = words.slice(0, Math.max(0, at)).join(' ');
    const distinctive =
      head.length >= 3 &&
      !this.ours(head) &&
      head
        .split(' ')
        .some((word) => !COMMON.has(word.toLowerCase()) && !GENERIC_HEADS.has(word.toLowerCase()));
    // Found in a message's words, it counts only with a name of its own.
    if (named && !distinctive) return;
    this.add(kind, [name, ...(distinctive ? [head] : [])]);
  }

  /** The private details in an original's own words. */
  scan(text: string) {
    for (const match of text.matchAll(ORGANISATION_NAME)) {
      const name = (match[1] ?? '').replace(/^(?:The|Your|Our|At|From)[ \t]+/, '');
      if (!name.includes(' ') || this.ours(name)) continue;
      this.organisation(
        name,
        ORGANISATIONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'company',
        true,
      );
    }
    for (const match of text.matchAll(TITLED_NAME)) {
      const role = TITLES.find(([pattern]) => pattern.test(match[1] ?? ''))?.[1] ?? 'person';
      if (match[2]) this.person(match[2], role);
    }
    for (const match of text.matchAll(CREDENTIAL_NAME)) {
      const role = CREDENTIALS.find(([pattern]) => pattern.test(match[2] ?? ''))?.[1] ?? 'doctor';
      if (match[1]) this.person(match[1], role);
    }
    for (const match of text.matchAll(LABELLED_NAME)) {
      const label = (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
      const role = LABELS.find(([word]) => word === label)?.[1] ?? 'person';
      if (match[2]) this.person(match[2], role);
    }
    for (const match of text.matchAll(MEDICINE)) {
      const name = match[1] ?? '';
      if (name && !name.split(/[ -]/).some((word) => COMMON.has(word.toLowerCase())))
        this.add('medicine', [name]);
    }
    for (const found of detect(text, ALL_CATEGORIES)) {
      const value = text.slice(found.start, found.end);
      if (found.category === 'email' && this.peopleAddresses.has(value.toLowerCase())) continue;
      let role = CATEGORY_ROLE[found.category];
      if (!role) continue;
      if (
        found.category === 'health' &&
        /\b(?:rx|prescription|refill)\b/i.test(
          text.slice(Math.max(0, found.start - 30), found.start),
        )
      )
        role = 'prescription number';
      if (found.category === 'name' && this.ours(value)) continue;
      this.add(role, [value]);
    }
    for (const [pattern, role] of IDENTIFIERS)
      for (const match of text.matchAll(pattern)) {
        const value = match[0];
        if (DATE_LIKE.test(value)) continue;
        const before = text.slice(Math.max(0, match.index - 30), match.index);
        const named =
          role === 'ID number' && /\b(?:rx|prescription)\b[^\n]{0,12}$/i.test(before)
            ? 'prescription number'
            : role;
        this.add(named, [value]);
      }
  }

  phrase(value: string, kind: PhraseKind) {
    const words = tokens(value).map((token) => token.word);
    const key = words.join(' ');
    if (words.length < 2 || this.seenPhrases.has(key) || this.phrases.length >= LIMITS.phrases)
      return;
    this.seenPhrases.add(key);
    this.phrases.push({ words, kind });
  }

  text(value: string) {
    const words = tokens(value).map((token) => token.word);
    for (let start = 0; start + QUOTE_RUN <= words.length; start++) {
      if (this.quotes.size >= LIMITS.quotes) return;
      if (words.slice(start, start + QUOTE_RUN).filter(says).length < 5) continue;
      this.quotes.add(digest(words, start, QUOTE_RUN));
    }
  }

  /** One read's receipt detail, walked field by field. */
  walk(value: unknown, field: string | null, depth = 0): void {
    if (depth > 12) return;
    if (typeof value === 'string') {
      if (!field) return;
      if (PEOPLE_FIELDS.has(field)) this.identities(value, SENDING_FIELDS.has(field));
      else if (TITLE_FIELDS[field]) {
        this.phrase(value, TITLE_FIELDS[field]);
        this.scan(value);
      } else if (TEXT_FIELDS.has(field)) {
        this.scan(value);
        this.text(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) this.walk(entry, field, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    // An attendee or organiser given as { name, email }.
    if (
      field &&
      PEOPLE_FIELDS.has(field) &&
      (typeof node.email === 'string' || typeof node.name === 'string')
    ) {
      const name = typeof node.name === 'string' ? node.name : '';
      const email = typeof node.email === 'string' ? node.email : '';
      this.identities(email ? `${name} <${email}>` : name, SENDING_FIELDS.has(field));
      return;
    }
    for (const [key, child] of Object.entries(node)) this.walk(child, key, depth + 1);
  }
}

/** The details of these reads' receipts, oldest first, so each placeholder keeps its number. */
export function readOriginals(details: readonly unknown[], people: RoomPeople): Originals {
  const harvest = new Harvest(people);
  for (const detail of details) harvest.walk(detail, null);
  return harvest.result();
}

// ---------------------------------------------------------------------------
// Finding them in what someone is about to read
// ---------------------------------------------------------------------------

type Span = { start: number; end: number; detail?: Detail; words?: string };

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A detail is found as its words in a row, whatever stands between them: so
 * "Okafor" in any case, "4410-2231-9087" as "4410 2231 9087", and an address
 * however it is punctuated. A number is also found written without its
 * separators. The words are indexed by the first of them, so finding every
 * detail in a text reads the text once, however many details there are.
 */
type Entry = { detail: Detail; words: string[] };
const detailIndexes = new WeakMap<Originals, Map<string, Entry[]>>();
function detailIndex(originals: Originals): Map<string, Entry[]> {
  const cached = detailIndexes.get(originals);
  if (cached) return cached;
  const index = new Map<string, Entry[]>();
  const put = (detail: Detail, words: string[]) => {
    const first = words[0];
    if (!first) return;
    const list = index.get(first) ?? [];
    list.push({ detail, words });
    index.set(first, list);
  };
  for (const detail of originals.details)
    for (const value of detail.values) {
      const words = tokens(value).map((token) => token.word);
      put(detail, words);
      const compact = value.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
      if (detail.numeric && words.length > 1 && compact.length >= 4) put(detail, [compact]);
    }
  // The longest of the details that start with a word is tried first.
  for (const list of index.values()) list.sort((a, b) => b.words.length - a.words.length);
  detailIndexes.set(originals, index);
  return index;
}

const LEADING_TITLE = new RegExp(`\\b${TITLE}\\.?\\s+$`, 'iu');
const TRAILING_CREDENTIAL = /^,?\s+(?:MD|M\.D\.|DO|DDS|DMD|RN|NP|PA-C|PharmD)\b/;

function detailSpans(text: string, originals: Originals): Span[] {
  const index = detailIndex(originals);
  if (!index.size) return [];
  const found = tokens(text);
  const spans: Span[] = [];
  for (let at = 0; at < found.length; at++) {
    const entries = index.get(found[at]?.word ?? '');
    if (!entries) continue;
    const entry = entries.find(({ words }) =>
      words.every((word, offset) => found[at + offset]?.word === word),
    );
    if (!entry) continue;
    const last = at + entry.words.length - 1;
    let start = found[at]?.start ?? 0;
    let end = found[last]?.end ?? start;
    if (entry.detail.titled) {
      const title = LEADING_TITLE.exec(text.slice(Math.max(0, start - 16), start));
      if (title) start -= title[0].length;
      const credential = TRAILING_CREDENTIAL.exec(text.slice(end, end + 12));
      if (credential) end += credential[0].length;
    }
    spans.push({ start, end, detail: entry.detail });
    at = last;
  }
  return spans;
}

type PhraseEntry = { words: string[]; kind: PhraseKind; at: number };
const indexes = new WeakMap<Originals, Map<string, PhraseEntry[]>>();
/** Where each word stands in the subjects and titles, built once per set of originals. */
function phraseIndex(originals: Originals): Map<string, PhraseEntry[]> {
  const cached = indexes.get(originals);
  if (cached) return cached;
  const index = new Map<string, PhraseEntry[]>();
  for (const phrase of originals.phrases)
    phrase.words.forEach((word, at) => {
      const list = index.get(word) ?? [];
      list.push({ ...phrase, at });
      index.set(word, list);
    });
  indexes.set(originals, index);
  return index;
}

function phraseSpans(text: string, originals: Originals): Span[] {
  if (!originals.phrases.length && !originals.quotes.size) return [];
  const found = tokens(text);
  const words = found.map((token) => token.word);
  const spans: Span[] = [];
  // Runs of a subject, title or file name: the longest run starting at each word.
  if (originals.phrases.length) {
    const firsts = phraseIndex(originals);
    for (let index = 0; index < words.length; index++) {
      let best = 0;
      let kind: PhraseKind = 'message';
      for (const candidate of firsts.get(words[index] ?? '') ?? []) {
        let length = 0;
        while (
          index + length < words.length &&
          candidate.words[candidate.at + length] === words[index + length]
        )
          length++;
        if (length < 2 || length <= best) continue;
        if (words.slice(index, index + length).filter(says).length < SUBJECT_RUN) continue;
        best = length;
        kind = candidate.kind;
      }
      if (best) {
        spans.push({
          start: found[index]?.start ?? 0,
          end: found[index + best - 1]?.end ?? 0,
          words: PHRASE_WORDS[kind],
        });
        index += best - 1;
      }
    }
  }
  // A long run of an original's words is a quote, however it is punctuated.
  if (originals.quotes.size)
    for (let index = 0; index + QUOTE_RUN <= words.length; index++) {
      if (!originals.quotes.has(digest(words, index, QUOTE_RUN))) continue;
      if (words.slice(index, index + QUOTE_RUN).filter(says).length < 5) continue;
      let last = index + QUOTE_RUN - 1;
      while (
        last + 1 < words.length &&
        originals.quotes.has(digest(words, last + 2 - QUOTE_RUN, QUOTE_RUN))
      )
        last++;
      spans.push({
        start: found[index]?.start ?? 0,
        end: found[last]?.end ?? 0,
        words: QUOTE_WORDS,
      });
      index = last;
    }
  return spans;
}

/** Overlapping spans become one, named as its longest part is. */
function merged(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: (Span & { weight: number })[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && span.start < last.end) {
      if (span.end - span.start > last.weight) {
        last.detail = span.detail;
        last.words = span.words;
        last.weight = span.end - span.start;
      }
      last.end = Math.max(last.end, span.end);
      continue;
    }
    out.push({ ...span, weight: span.end - span.start });
  }
  return out;
}

const DETERMINER = /\b(?:the|a|an|her|his|their|your|my|our|its|this|that)\s+$/i;
const SENTENCE_START = /(?:^|[.!?]\s+|\n\s*|[-*•]\s+|:\s+)$/;

/** The words a span is replaced by, fitted to where it stands. */
/** Short labels and the word of a detail's role they stand for. */
const LABEL_WORDS: Record<string, string> = {
  rx: 'prescription',
  acct: 'account',
  tel: 'phone',
  ph: 'phone',
  mobile: 'phone',
  cell: 'phone',
  email: 'email',
  id: 'id',
};

function wordsFor(words: string, before: string): string {
  // "account 4410…" or "Phone: 555-…" already says what it is.
  const label = /([\p{L}]+)[\s:#]*$/u.exec(before)?.[1]?.toLowerCase();
  const said = label ? (LABEL_WORDS[label] ?? label) : '';
  if (said.length > 1 && words.toLowerCase().split(' ').includes(said)) return 'kept back';
  let out = words;
  if (DETERMINER.test(before)) out = out.replace(/^(?:the|a|an)\s+/, '');
  if (SENTENCE_START.test(before)) out = (out[0]?.toUpperCase() ?? '') + out.slice(1);
  return out;
}

const PLACEHOLDER = new RegExp(
  `\\[(${Object.keys(ROLE_WORDS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|')}) \\d{1,5}\\]`,
  'g',
);

export type Scrubbed = { text: string; kept: number };

/**
 * Text as a summaries-only reader may read it. `kept` counts the details that
 * were still in it; the model's own placeholders are put into words and not
 * counted, since those details never reached it.
 */
export function scrub(text: string, originals: Originals): Scrubbed {
  if (!text) return { text, kept: 0 };
  const spans = merged([...detailSpans(text, originals), ...phraseSpans(text, originals)]);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    const words = span.detail ? ROLE_WORDS[span.detail.role] : (span.words ?? QUOTE_WORDS);
    out += wordsFor(words, out.slice(-40));
    cursor = span.end;
  }
  out += text.slice(cursor);
  let placed = '';
  let at = 0;
  for (const match of out.matchAll(PLACEHOLDER)) {
    placed += out.slice(at, match.index);
    placed += wordsFor(ROLE_WORDS[match[1] as DetailRole], placed.slice(-40));
    at = match.index + match[0].length;
  }
  placed += out.slice(at);
  return { text: placed, kept: spans.length };
}

/** Every string in a value scrubbed, keys and ids aside. */
export function scrubDeep<T>(value: T, originals: Originals, counter?: { kept: number }): T {
  const visit = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string') {
      if (key && /^(?:id|.*_id|handle|url|href|seq|kind|type|status|state|at|.*_at)$/.test(key))
        return node;
      const result = scrub(node, originals);
      if (counter) counter.kept += result.kept;
      return result.text;
    }
    if (Array.isArray(node)) return node.map((entry) => visit(entry, key));
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([field, child]) => [
        field,
        visit(child, field),
      ]),
    );
  };
  return visit(value, null) as T;
}

/** The placeholder a detail goes to the model as. */
const placeholderOf = (detail: Detail) => `[${detail.role} ${detail.n}]`;

/** Text as the model reads it for a summaries-only reader: each detail by its placeholder. */
export function minimise(text: string, originals: Originals): string {
  if (!text || !originals.details.length) return text;
  const spans = merged(detailSpans(text, originals));
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += span.detail ? placeholderOf(span.detail) : '';
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * The redactor's walk over a whole request body, with each string minimised.
 * Signed or provider-written reasoning is left byte for byte, as the router
 * leaves it; only structural fields are skipped.
 */
class Minimiser extends Redactor {
  constructor(private readonly originals: Originals) {
    super(new Vault(), { enabled: new Set() });
  }

  override text(input: string, mode: 'full' | 'vault' = 'full'): string {
    return mode === 'vault' ? input : minimise(input, this.originals);
  }
}

export function minimiseBody(
  body: Record<string, unknown>,
  protocol: Protocol,
  originals: Originals,
): Record<string, unknown> {
  if (!originals.details.length) return body;
  return new Minimiser(originals).body(body, protocol);
}

// ---------------------------------------------------------------------------
// Who reads what, from the database
// ---------------------------------------------------------------------------

/** How far back a room's reads are kept in mind, and how many. */
const WINDOW_DAYS = 30;
const WINDOW_READS = 200;
const CACHE_SPACES = 64;
/** A room's harvest is begun again after this long, so that old reads fall out of it. */
const CACHE_MS = 6 * 3_600_000;
type Kept = {
  people: string;
  harvest: Harvest;
  seen: Set<string>;
  latest: Date;
  begun: number;
  originals: Originals;
};
const cache = new Map<string, Kept>();

/** The maker of a space: its owner, or the installation's owner for one made before owners. */
async function makerOf(reader: Reader, spaceId: string) {
  const [row] = await reader
    .select({
      kind: space.kind,
      maker: sql<
        string | null
      >`coalesce(${space.ownerPrincipalId}, (select ${owner.id} from ${owner} limit 1))`,
      on: spacePolicy.summariesOnly,
    })
    .from(space)
    .leftJoin(spacePolicy, eq(spacePolicy.spaceId, space.id))
    .where(eq(space.id, spaceId));
  return row ?? null;
}

/** The details of a room's originals, read from its recent reads, cached until it reads again. */
export async function originalsIn(reader: Reader, spaceId: string): Promise<Originals> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const reads = and(
    eq(connection.spaceId, spaceId),
    inArray(action.kind, [...ORIGINAL_READS]),
    eq(action.status, 'succeeded'),
    gt(action.createdAt, since),
  );
  const people = await reader
    .select({ name: principal.displayName, email: principal.email })
    .from(spaceMembership)
    .innerJoin(principal, eq(principal.id, spaceMembership.principalId))
    .where(and(eq(spaceMembership.spaceId, spaceId), isNull(spaceMembership.revokedAt)));
  const mailboxes = await reader
    .select({ configuration: connection.configuration })
    .from(connection)
    .where(eq(connection.spaceId, spaceId));
  const room: RoomPeople = {
    names: people.flatMap((row) => (row.name ? [row.name] : [])),
    addresses: [
      ...people.flatMap((row) => (row.email ? [row.email] : [])),
      ...mailboxes.flatMap(({ configuration }) =>
        ['from', 'address', 'email', 'username'].flatMap((key) => {
          const value = configuration?.[key];
          return typeof value === 'string' && value.includes('@') ? [value] : [];
        }),
      ),
    ],
  };
  const peopleKey = JSON.stringify(room);
  const hit = cache.get(spaceId);
  // Reads since the last look are added to what is kept; anything else begins again.
  const kept = hit && hit.people === peopleKey && Date.now() - hit.begun < CACHE_MS ? hit : null;
  const rows = await reader
    .select({ id: action.id, at: action.createdAt, receipt: action.receipt })
    .from(action)
    .innerJoin(connection, eq(connection.id, action.connectionId))
    .where(kept ? and(reads, gte(action.createdAt, kept.latest)) : reads)
    .orderBy(desc(action.createdAt), desc(action.id))
    .limit(WINDOW_READS);
  const fresh = kept ? rows.filter((row) => !kept.seen.has(row.id)) : rows;
  if (kept && !fresh.length) return kept.originals;
  const entry: Kept = kept ?? {
    people: peopleKey,
    harvest: new Harvest(room),
    seen: new Set(),
    latest: since,
    begun: Date.now(),
    originals: EMPTY_ORIGINALS,
  };
  // Oldest first, so each placeholder keeps its number as more is read.
  for (const row of fresh.reverse()) {
    entry.harvest.walk((row.receipt as { detail?: unknown } | null)?.detail ?? null, null);
    entry.seen.add(row.id);
    if (row.at > entry.latest) entry.latest = row.at;
  }
  entry.originals = entry.harvest.result();
  cache.delete(spaceId);
  cache.set(spaceId, entry);
  if (cache.size > CACHE_SPACES) cache.delete(cache.keys().next().value as string);
  return entry.originals;
}

/**
 * The details this person may not read in this space, or null when they read
 * it as it is: the space is not a room set to summaries only, or they made it.
 */
export async function guardFor(
  reader: Reader,
  spaceId: string,
  principalId: string | null,
): Promise<Originals | null> {
  const row = await makerOf(reader, spaceId);
  if (!row || row.kind === 'personal' || row.on !== true) return null;
  if (principalId !== null && principalId === row.maker) return null;
  return originalsIn(reader, spaceId);
}

/**
 * The details to keep out of what the model reads for this job: a request in a
 * summaries-only room that its maker did not ask. Work nobody asked (a wake on
 * new mail) is read by the whole room, so it is minimised too.
 */
export async function minimiserFor(reader: Reader, jobId: string): Promise<Originals | null> {
  const [row] = await reader
    .select({ spaceId: job.spaceId, requester: job.requestedByPrincipalId })
    .from(job)
    .where(eq(job.id, jobId));
  if (!row) return null;
  const originals = await guardFor(reader, row.spaceId, row.requester ?? null);
  return originals?.details.length ? originals : null;
}

/** The model gateway's `minimise`, reading each attempt's job from `reader`. */
export function summariesMinimiser(reader: Reader) {
  return async (principal: { jobId: string }) => {
    const originals = await minimiserFor(reader, principal.jobId);
    return originals
      ? (body: Record<string, unknown>, protocol: Protocol) =>
          minimiseBody(body, protocol, originals)
      : null;
  };
}

/** Forget what was read, for tests that rewrite a room's reads in place. */
export function forgetOriginals(): void {
  cache.clear();
}

/** The receipt line that says details were kept out of what a person reads. */
export function keptLine(kept: number, where: 'answer' | 'request'): string {
  const what = kept === 1 ? '1 private detail' : `${kept} private details`;
  return where === 'answer'
    ? `Kept ${what} out of this answer`
    : `Kept ${what} out of this request`;
}
