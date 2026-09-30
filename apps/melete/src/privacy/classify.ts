/**
 * Which conversations are too sensitive to redact and send: therapy, health
 * records, personal finances. These run on the person's own model, or wait for
 * them to say otherwise.
 *
 * The rules read what the person wrote and what tools brought back, never the
 * system prompt (memory and skills there mention these words constantly). One
 * strong phrase ("my therapy notes", "tax return") is enough; otherwise three
 * different topic words must appear in the person's own words, so a passing
 * "anxiety about the trip" does not move a conversation off the cloud model.
 * Text a tool brought back counts only through strong phrases: a newsletter
 * that mentions interest rates is not a finance conversation.
 */
import type { SensitiveTopic } from '@melete/contracts';
import type { Protocol } from './redact.ts';

type Topic = { strong: RegExp; weak: RegExp };

const TOPICS: Record<SensitiveTopic, Topic> = {
  health: {
    strong:
      /\b(?:medical (?:records?|history|report|chart|notes?)|health records?|lab (?:results?|report|work)|blood (?:test|work) results?|discharge (?:summary|papers|notes)|diagnosed with|my diagnosis|a diagnosis of|biopsy|pathology report|MRI (?:results?|report|scan)|CT scan|x-ray results?|prescriptions? (?:for|history|list)|my (?:medications?|meds|symptoms)|chemotherapy|oncolog(?:y|ist)|HIV|miscarriage|pregnancy test|ICD-?10 codes?)\b/i,
    weak: /\b(?:doctor|physician|clinic|hospital|patient|symptoms?|medication|dosage|prescri(?:bed|ption)|surgery|treatment|illness|disease|allerg(?:y|ies)|chronic|insulin|diabetes|cancer|pregnan(?:t|cy)|referral|specialist|cardiolog\w*|neurolog\w*|dermatolog\w*|ultrasound|vaccin\w*)\b/i,
  },
  therapy: {
    strong:
      /\b(?:therapy (?:notes?|sessions?)|session notes|my therap(?:y|ist)|counsel(?:l)?ing (?:notes?|sessions?)|psychiatr(?:ist|ic)|psycholog(?:ist|ical assessment)|mental health|panic attacks?|suicid(?:e|al)|self[- ]harm|eating disorder|PTSD|bipolar|schizophreni\w*|depressive episode|trauma (?:therapy|history)|rehab(?:ilitation)? (?:for|program)|addiction|relapse)\b/i,
    weak: /\b(?:therap(?:y|ist)|counsel(?:l)?or|counsel(?:l)?ing|anxiety|depress(?:ed|ion)|trauma|grief|feelings|intrusive thoughts|mood|journal(?:ing)?|medicat(?:ed|ion)|CBT|DBT|EMDR|coping)\b/i,
  },
  finance: {
    strong:
      /\b(?:bank statements?|tax returns?|W-2 form|form W-?2|form 1099|1099-(?:MISC|NEC|INT|DIV|B|K|R)|P60|payslips?|pay ?stubs?|credit reports?|credit score|mortgage (?:statement|application)|loan application|net worth|brokerage statement|401\(?k\)? (?:statement|balance)|IRA (?:statement|balance)|investment portfolio|my (?:debts?|salary|income|finances)|bankruptcy|account statements?|transaction history)\b/i,
    weak: /\b(?:account balance|transactions?|salary|income|tax(?:es)?|IRS|HMRC|mortgage|loan|debts?|credit card|investments?|portfolio|pension|dividends?|brokerage|overdraft|interest rate)\b/i,
  },
};

const ORDER: SensitiveTopic[] = ['therapy', 'health', 'finance'];

function distinctWeak(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, 'gi');
  const seen = new Set<string>();
  for (const match of text.matchAll(global)) seen.add(match[0].toLowerCase());
  return seen.size;
}

/** The first enabled topic this text belongs to, or null. */
export function classify(
  text: string | { person: string; tools: string },
  enabled: readonly SensitiveTopic[],
): SensitiveTopic | null {
  const { person, tools } = typeof text === 'string' ? { person: text, tools: '' } : text;
  if (!person.trim() && !tools.trim()) return null;
  for (const topic of ORDER) {
    if (!enabled.includes(topic)) continue;
    const rules = TOPICS[topic];
    if (rules.strong.test(person) || rules.strong.test(tools)) return topic;
    if (distinctWeak(person, rules.weak) >= 3) return topic;
  }
  return null;
}

/** What one string says about each topic; the same string always says the same. */
export type TopicHits = { strong: SensitiveTopic[]; weak: Record<SensitiveTopic, string[]> };

function hitsOf(text: string): TopicHits {
  const hits: TopicHits = { strong: [], weak: { health: [], therapy: [], finance: [] } };
  for (const topic of ORDER) {
    const rules = TOPICS[topic];
    if (rules.strong.test(text)) hits.strong.push(topic);
    const global = new RegExp(rules.weak.source, 'gi');
    hits.weak[topic] = [
      ...new Set([...text.matchAll(global)].map((match) => match[0].toLowerCase())),
    ];
  }
  return hits;
}

/**
 * `classify` over the separate strings of a request, each read once and
 * remembered: a conversation re-sends its whole history every turn, and only
 * the new messages need reading.
 */
export function classifyParts(
  parts: { person: string[]; tools: string[] },
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
  const person = parts.person.map(read);
  const tools = parts.tools.map(read);
  for (const topic of ORDER) {
    if (!enabled.includes(topic)) continue;
    if ([...person, ...tools].some((hits) => hits.strong.includes(topic))) return topic;
    const words = new Set(person.flatMap((hits) => hits.weak[topic]));
    if (words.size >= 3) return topic;
  }
  return null;
}

/** What the person and the tools contributed to a request: never system or developer text. */
export function authoredText(
  body: Record<string, unknown>,
  protocol: Protocol,
): { person: string; tools: string } {
  const parts = authoredParts(body, protocol);
  return { person: parts.person.join('\n'), tools: parts.tools.join('\n') };
}

/** The same, one string per message part. */
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
