/**
 * Which conversations are too sensitive to redact and send: therapy, health
 * records, personal finances. These run on the person's own model, or wait for
 * them to say otherwise.
 *
 * Only the person's own words decide it. What a tool brought back (a web page,
 * a search result, a file, an email) never makes a conversation sensitive: a
 * news story about a continent's "addiction" to gas is not a therapy
 * conversation. Tool text still has its details swapped for placeholders, span
 * by span, before a cloud model sees it.
 *
 * In the person's words one topic word is not enough either. It takes a phrase
 * about themselves or their own records ("my therapist", "I was diagnosed
 * with", "my bank account number", "my tax returns"), a crisis or condition
 * named in any form ("suicide", "in rehab", "PTSD"), or three different topic
 * words in what they wrote, so a passing "anxiety about the trip" or a
 * question about a news story does not move a conversation off the cloud
 * model. The person can clear a verdict that is wrong; after that, only such
 * a phrase in something they write later marks it again.
 */
import type { SensitiveTopic } from '@melete/contracts';
import type { Protocol } from './redact.ts';

type Topic = { strong: RegExp[]; weak: RegExp };

const WORD = String.raw`[\w'’-]+\s+`;
/** The person speaking about themselves: "my …", "I have been …", "I'm …". */
const SELF = `(?:my|I(?:['’]m|['’]ve| am| have| had| was| got| get| feel| take| need| keep)(?: been)?)`;
/** Their own documents, or the ones in front of them: "my", "our", "these", "the attached". */
const OWN = `(?:my|our|these|this|those|attached)`;

/** The person about themselves, with up to two words between: "I have been struggling with X". */
const about = (terms: string) =>
  new RegExp(String.raw`\b${SELF}\s+(?:${WORD}){0,2}?(?:${terms})\b`, 'i');
/** Their own records: "my last two bank statements", "these lab results". */
const records = (terms: string) =>
  new RegExp(String.raw`\b${OWN}\s+(?:${WORD}){0,2}?(?:${terms})\b`, 'i');
const phrase = (terms: string) => new RegExp(String.raw`\b(?:${terms})\b`, 'i');

const TOPICS: Record<SensitiveTopic, Topic> = {
  health: {
    strong: [
      records(
        `medical (?:records?|history|reports?|charts?|notes?)|health records?|lab (?:results?|reports?|work)|blood (?:tests?|work)(?: results?)?|discharge (?:summary|papers|notes)|pathology reports?|biopsy(?: results?)?|(?:MRI|CT|PET) (?:scans?|results?|reports?)|x-ray results?|prescriptions?|ICD-?10 codes?`,
      ),
      about(
        String.raw`diagnos(?:is|ed)|symptoms|medications?|meds|surgery|chemo(?:therapy)?|biopsy|HIV|cancer|diabetes|tumou?r|miscarriage|pregnan(?:t|cy)|blood pressure|allerg(?:y|ies)|illness|chronic \w+|treatment`,
      ),
      phrase(
        `my (?:doctor|GP|oncologist|surgeon|cardiologist|neurologist)|I(?:['’]ve| have| was| got| am)(?: been| being)? diagnosed|a diagnosis of`,
      ),
    ],
    weak: /\b(?:doctor|physician|clinic|hospital|patient|symptoms?|medication|dosage|prescri(?:bed|ption)|surgery|treatment|illness|disease|allerg(?:y|ies)|chronic|insulin|diabetes|cancer|pregnan(?:t|cy)|referral|specialist|cardiolog\w*|neurolog\w*|dermatolog\w*|ultrasound|vaccin\w*|biopsy|HIV)\b/i,
  },
  therapy: {
    strong: [
      records(`(?:therapy|counsel(?:l)?ing) (?:session )?(?:notes?|sessions?)|session notes`),
      phrase(
        `my (?:therapist|psychiatrist|psychologist|counsel(?:l)?or|shrink)|I(?:['’]m| am) (?:feeling )?(?:suicidal|depressed)|(?:kill|hurt|harm) myself|relapse prevention plan`,
      ),
      // A crisis or a condition the person names is sensitive however they put
      // it, and whoever it is about ("I think about suicide", "my brother is in
      // rehab"). A wrong verdict costs one tap to clear; a missed one sends it on.
      phrase(
        String.raw`suicid(?:e|al)|self[- ]harm(?:ing|ed)?|end(?:ing)? my (?:own )?life|eating disorders?|anorexi(?:a|c)|bulimi(?:a|c)|PTSD|schizophreni\w*|(?:in|into|to|from|out of) rehab|rehab (?:for|program(?:me)?|centre|center|clinic|facility)|psychiatric (?:hospital|ward|unit|hold|admission)`,
      ),
      about(
        String.raw`depression|depressive episodes?|anxiety (?:disorder|attacks?)|panic attacks?|PTSD|bipolar|schizophreni\w*|eating disorder|addiction|relapsed?|rehab|OCD|ADHD|self[- ]harm(?:ing)?|suicidal(?: thoughts)?|mental health|trauma|therapy|psychiatric \w+`,
      ),
    ],
    weak: /\b(?:therap(?:y|ist)|counsel(?:l)?or|counsel(?:l)?ing|anxiety|depress(?:ed|ion)|trauma|grief|feelings|intrusive thoughts|mood|journal(?:ing)?|medicat(?:ed|ion)|CBT|DBT|EMDR|coping|addiction|relapse|psychiatr\w+|panic)\b/i,
  },
  finance: {
    strong: [
      records(
        String.raw`bank statements?|tax returns?|W-?2s?|W-2 forms?|1099s?|1099-(?:MISC|NEC|INT|DIV|B|K|R)|P60s?|payslips?|pay ?stubs?|credit reports?|mortgage (?:statements?|applications?)|loan applications?|brokerage statements?|401\(?k\)? (?:statements?|balances?)|IRA (?:statements?|balances?)|account statements?|transaction history|card statements?`,
      ),
      phrase(
        String.raw`(?:my|our) (?:bank account(?: number| details| balance)?|account (?:number|balance)|routing number|sort code|IBAN|card number|credit card(?: number| statement| debt)?|debts?|salary|income|finances|net worth|credit score|savings(?: account)?|investments?|investment portfolio|pension|mortgage|loans?|tax(?:es)?|bankruptcy|401\(?k\)?|IRA)|(?:I|we)(?:['’]m|['’]re| am| are)? (?:filing|filed|declaring|declared) (?:for )?bankruptcy|I owe`,
      ),
    ],
    weak: /\b(?:account balance|transactions?|salary|income|tax(?:es)?|IRS|HMRC|mortgage|loan|debts?|credit card|investments?|portfolio|pension|dividends?|brokerage|overdraft|interest rate|bankruptcy|credit score|net worth)\b/i,
  },
};

const ORDER: SensitiveTopic[] = ['therapy', 'health', 'finance'];

/** What one string says about each topic; the same string always says the same. */
export type TopicHits = { strong: SensitiveTopic[]; weak: Record<SensitiveTopic, string[]> };

function hitsOf(text: string): TopicHits {
  const hits: TopicHits = { strong: [], weak: { health: [], therapy: [], finance: [] } };
  for (const topic of ORDER) {
    const rules = TOPICS[topic];
    if (rules.strong.some((rule) => rule.test(text))) hits.strong.push(topic);
    const global = new RegExp(rules.weak.source, 'gi');
    hits.weak[topic] = [
      ...new Set([...text.matchAll(global)].map((match) => match[0].toLowerCase())),
    ];
  }
  return hits;
}

function verdict(
  said: readonly TopicHits[],
  enabled: readonly SensitiveTopic[],
): SensitiveTopic | null {
  for (const topic of ORDER) {
    if (!enabled.includes(topic)) continue;
    if (said.some((hits) => hits.strong.includes(topic))) return topic;
    if (new Set(said.flatMap((hits) => hits.weak[topic])).size >= 3) return topic;
  }
  return null;
}

/** The first enabled topic the person's own words belong to, or null. */
export function classify(
  person: string,
  enabled: readonly SensitiveTopic[],
): SensitiveTopic | null {
  if (!person.trim()) return null;
  return verdict([hitsOf(person)], enabled);
}

/**
 * The first enabled topic a phrase in the person's words names outright: a
 * phrase about themselves or their own records, or a crisis or condition. No
 * count of passing topic words. This is what reopens a conversation the person
 * said is not sensitive, when they later write such a phrase in it.
 */
export function classifyStrong(
  person: readonly string[],
  enabled: readonly SensitiveTopic[],
): SensitiveTopic | null {
  for (const topic of ORDER) {
    if (!enabled.includes(topic)) continue;
    if (person.some((text) => TOPICS[topic].strong.some((rule) => rule.test(text)))) return topic;
  }
  return null;
}

/**
 * `classify` over the separate messages the person wrote, each read once and
 * remembered: a conversation re-sends its whole history every turn, and only
 * the new messages need reading.
 */
export function classifyParts(
  person: readonly string[],
  enabled: readonly SensitiveTopic[],
  cache: Map<string, TopicHits>,
): SensitiveTopic | null {
  const read = (text: string) => {
    let hits = cache.get(text);
    if (!hits) {
      if (cache.size >= 20_000) cache.clear();
      hits = hitsOf(text);
      cache.set(text, hits);
    }
    return hits;
  };
  return verdict(person.filter((text) => text.trim()).map(read), enabled);
}

/**
 * What the person and the tools contributed to a request, one string per message
 * part: never system or developer text.
 */
export function authoredParts(
  body: Record<string, unknown>,
  protocol: Protocol,
): { person: string[]; tools: string[] } {
  const person: string[] = [];
  const tools: string[] = [];
  const collect = (value: unknown, into: string[]) => {
    if (typeof value === 'string') into.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item, into);
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      // Anthropic tool results arrive inside the person's turn.
      const target = node.type === 'tool_result' ? tools : into;
      for (const key of ['text', 'content', 'output']) collect(node[key], target);
    }
  };
  if (protocol === 'responses') {
    const input = body.input;
    if (typeof input === 'string') person.push(input);
    else if (Array.isArray(input))
      for (const item of input) {
        const node = item as Record<string, unknown> | null;
        if (!node || typeof node !== 'object') continue;
        if (node.type === 'function_call_output') collect(node.output, tools);
        else if (node.role === 'user') collect(node.content, person);
      }
    return { person, tools };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const message = raw as Record<string, unknown> | null;
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') collect(message.content, person);
    else if (message.role === 'tool') collect(message.content, tools);
  }
  return { person, tools };
}
