/**
 * The person's own don't-rules.
 *
 * The agent acts on its own and asks only for money moves and the person's own
 * don't-rules. A don't-rule is something the person said not to do ("don't
 * email Bob", "never book Ryanair", "stop posting in #general") in one of
 * three places that are theirs:
 *
 * - their memory, as an item they told Melete themselves (owner origin);
 * - the instructions they gave the agent doing the work;
 * - their own messages in this conversation.
 *
 * An action that a rule covers waits on its card, and the card quotes the rule
 * and says where it came from. Nothing else is flagged: with no rule, nothing
 * is. The reading is a plain rule over the words, the same at every phase,
 * never the model's opinion of them.
 *
 * A rule covers an action when the kind of thing it forbids matches the action
 * (sending to someone, paying or booking, deleting, a calendar change,
 * posting) and, when the rule names someone or something, the action's
 * arguments name it too. The person's own message in the turn being answered
 * that asks for that very thing lifts an older rule for that turn: they have
 * just said otherwise.
 */
import type { JsonValue } from '@melete/contracts';
import { directSend } from '../experience/access.ts';
import { memoryScopeForSpace, saysVerbatim } from '../memory/broker-trust.ts';
import type { Query } from './records.ts';

export type DontKind = 'contact' | 'money' | 'delete' | 'calendar' | 'publish';
export type DontSource = 'memory' | 'instruction' | 'conversation';
export type DontRule = {
  /** The person's words, as they said them. */
  text: string;
  source: DontSource;
  /** True when it was said in the turn being answered. */
  current?: boolean;
};
export type DontMatch = { rule: DontRule; reason: string };

/** Words that open a prohibition. */
const PROHIBIT =
  /\b(?:don'?t|dont|do not|never|stop|no more|avoid|without asking|not allowed to|shouldn'?t|should not|must not|mustn'?t)\b/i;
/** "Don't forget to email Bob" asks for it; these openers are not prohibitions. */
const NOT_PROHIBIT = /^(?:forget|hesitate|miss|worry|mind|wait|be shy|let me forget|skip)\b/i;

const KIND_WORDS: Record<DontKind, RegExp> = {
  contact:
    /\b(?:e-?mail(?:s|ing|ed)?|mail(?:s|ing)?|message(?:s|d|ing)?|text(?:s|ing|ed)?|sms|send(?:s|ing)?|repl(?:y|ies|ying)|respond(?:ing)?|write to|writing to|contact(?:ing)?|reach(?:ing)? out|call(?:s|ing)?|ping(?:ing)?|dm(?:s|ing)?|cc(?:ing)?|forward(?:s|ing)?)\b/i,
  money:
    /\b(?:pay(?:s|ing|ments?)?|buy(?:s|ing)?|purchas(?:e|es|ing)|order(?:s|ing)?|book(?:s|ing|ings)?|reserv(?:e|es|ing|ations?)|spend(?:s|ing)?|subscrib(?:e|es|ing)|charg(?:e|es|ing)|tip(?:s|ping)?|donat(?:e|es|ing))\b/i,
  delete:
    /\b(?:delet(?:e|es|ing)|remov(?:e|es|ing)|archiv(?:e|es|ing)|trash(?:es|ing)?|eras(?:e|es|ing)|cancel(?:s|ling|ing)?|unsubscrib(?:e|es|ing))\b/i,
  calendar:
    /\b(?:schedul(?:e|es|ing)|reschedul(?:e|es|ing)|calendar|meetings?|invit(?:e|es|ing)|events?|appointments?)\b/i,
  publish:
    /\b(?:post(?:s|ing)?|publish(?:es|ing)?|shar(?:e|es|ing)|tweet(?:s|ing)?|comment(?:s|ing)?)\b/i,
};

/** Words that start a sentence or name days and months: never a person's name. */
const NOT_A_NAME = new Set([
  'i',
  'melete',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'please',
  'ok',
  'okay',
]);

/** The same openers, for the database to narrow memory with (its own regex dialect). */
const PROHIBIT_SQL =
  "(don'?t|dont|do not|never|stop|no more|avoid|without asking|not allowed to|shouldn'?t|should not|must not|mustn'?t)";
/** Sentences end at a stop followed by space, or a line break: "acme.com" stays whole. */
const SENTENCES = /(?<=[.!?;])\s+|\n+/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const DOMAIN_SOURCE = String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|co|ai|app|dev|uk|us|de|fr|edu|gov)\b`;
const DOMAIN = new RegExp(DOMAIN_SOURCE, 'gi');
const IS_DOMAIN = new RegExp(`^${DOMAIN_SOURCE}$`, 'i');
const HANDLE = /(?:^|\s)([#@][\w.-]{2,})/g;
const NAME = /\b[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)*/gu;
const ROLE = /\bmy\s+([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,})?)\b/gi;

export type ParsedRule = { kinds: DontKind[]; targets: string[] };

/** What one prohibition forbids: the kinds of action and whom or what it names. */
function parseClause(rest: string): ParsedRule | null {
  if (NOT_PROHIBIT.test(rest.trim())) return null;
  const kinds = (Object.keys(KIND_WORDS) as DontKind[]).filter((kind) =>
    KIND_WORDS[kind].test(rest),
  );
  const targets = new Set<string>();
  const emails = rest.match(EMAIL) ?? [];
  for (const email of emails) targets.add(email.toLowerCase());
  const bare = rest.replace(EMAIL, ' ');
  for (const domain of bare.match(DOMAIN) ?? []) targets.add(domain.toLowerCase());
  for (const match of bare.matchAll(HANDLE)) if (match[1]) targets.add(match[1].toLowerCase());
  for (const match of bare.matchAll(ROLE)) {
    const role = match[1]?.toLowerCase();
    if (role && !KIND_WORDS.contact.test(role)) targets.add(role);
  }
  for (const name of bare.match(NAME) ?? []) {
    const lower = name.toLowerCase();
    const isKindWord = (Object.values(KIND_WORDS) as RegExp[]).some((words) =>
      new RegExp(`^(?:${words.source})$`, 'i').test(lower),
    );
    if (!NOT_A_NAME.has(lower) && !IS_DOMAIN.test(name) && !isKindWord) targets.add(lower);
  }
  if (kinds.length === 0 && targets.size === 0) return null;
  return { kinds, targets: [...targets] };
}

/** Each prohibition a text states, or none. */
export function parseRule(text: string): ParsedRule[] {
  const found: ParsedRule[] = [];
  for (const sentence of text.replace(/[’‘]/g, "'").split(SENTENCES)) {
    const hit = PROHIBIT.exec(sentence);
    if (!hit) continue;
    // "Do not ever" / "never, ever": what follows the opener is what is forbidden.
    const rest = sentence.slice(hit.index + hit[0].length).replace(/^[\s,]*(?:ever\s+)?/i, '');
    const parsed = parseClause(rest);
    if (parsed) found.push(parsed);
  }
  return found;
}

/** The kinds of thing an action does, by its tool's name. Reads do none. */
export function actionKinds(kind: string, movesMoney: boolean): DontKind[] {
  const name = kind.toLowerCase();
  const kinds: DontKind[] = [];
  if (
    directSend(name) ||
    /(?:^|[._])(?:reply|forward|message|post_message|send_message|send_email|sms|dm)(?:$|[._])/.test(
      name,
    )
  )
    kinds.push('contact');
  if (
    movesMoney ||
    /(?:^|[._])(?:book|booking|reserve|order|buy|purchase|pay)(?:$|[._])/.test(name)
  )
    kinds.push('money');
  if (/(?:^|[._])(?:delete|remove|archive|trash|erase|cancel|unsubscribe)(?:$|[._])/.test(name))
    kinds.push('delete');
  if (/(?:^|[._])(?:calendar|event|events|meeting|invite)(?:$|[._])/.test(name))
    kinds.push('calendar');
  if (/(?:^|[._])(?:publish|post|share|comment|tweet)(?:$|[._])/.test(name)) kinds.push('publish');
  return kinds;
}

/** Free text an action writes: a name inside it is what is said, not whom it reaches. */
const WRITTEN = /^(?:body|text|content|message|html|description|notes?|summary|markdown|prompt)$/i;

/** Every string an action's arguments carry, but for the text it writes. */
function strings(value: JsonValue, found: string[] = [], depth = 0): string[] {
  if (depth > 12) return found;
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found, depth + 1);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      if (!WRITTEN.test(key)) strings(item as JsonValue, found, depth + 1);
  return found;
}

/** Whether an address's own name part is this person: `bob@…`, `bob.smith@…`, `b.smith@…` no. */
function addressNames(value: string, target: string): boolean {
  const words = target.split(/\s+/);
  return (value.toLowerCase().match(EMAIL) ?? []).some((address) => {
    const local = address.slice(0, address.indexOf('@')).split(/[._+-]+/);
    return words.every((word) => local.includes(word));
  });
}

/** Whether the action's arguments name a target the rule names. */
function names(values: readonly string[], target: string): boolean {
  if (target.includes('@') && !target.startsWith('@'))
    return values.some((value) => value.toLowerCase().includes(target));
  return values.some((value) => saysVerbatim(value, target) || addressNames(value, target));
}

/** Whether a rule, as parsed, covers an action. */
function covers(parsed: ParsedRule, kinds: readonly DontKind[], values: readonly string[]) {
  if (parsed.kinds.length > 0 && !parsed.kinds.some((kind) => kinds.includes(kind))) return false;
  if (parsed.targets.length === 0) return parsed.kinds.length > 0;
  return parsed.targets.some((target) => names(values, target));
}

/**
 * Whether the person's message asks, in so many words, for what the rule
 * forbids: a clause with no prohibition that names its kind and its target.
 */
function asksFor(text: string, parsed: ParsedRule): boolean {
  return text
    .replace(/[’‘]/g, "'")
    .split(SENTENCES)
    .some((sentence) => {
      if (PROHIBIT.test(sentence)) return false;
      const kindSaid =
        parsed.kinds.length === 0 || parsed.kinds.some((kind) => KIND_WORDS[kind].test(sentence));
      const targetSaid =
        parsed.targets.length === 0 || parsed.targets.some((target) => names([sentence], target));
      return kindSaid && targetSaid;
    });
}

const WHERE: Record<DontSource, string> = {
  memory: 'you told Melete this, and it is in your memory',
  instruction: "it is in this agent's instructions",
  conversation: 'you said this earlier in this chat',
};

/** The card's reason: the rule in the person's own words, and where it came from. */
export function citation(rule: DontRule): string {
  const words = rule.text.trim().replace(/\s+/g, ' ');
  const quoted = words.length > 160 ? `${words.slice(0, 157)}…` : words;
  return `It goes against something you said: “${quoted}” (${rule.current ? 'you said this in your message' : WHERE[rule.source]}).`;
}

/**
 * The first rule that covers this action, or null. `rules` are in the order
 * they are weighed; `current` is the person's message in the turn being
 * answered, which can lift an older rule by asking for that very thing.
 */
export function matchDontRule(input: {
  rules: readonly DontRule[];
  kind: string;
  payload: JsonValue;
  movesMoney: boolean;
  current?: string | null;
}): DontMatch | null {
  const kinds = actionKinds(input.kind, input.movesMoney);
  if (kinds.length === 0) return null;
  const values = strings(input.payload);
  for (const rule of input.rules)
    for (const parsed of parseRule(rule.text)) {
      if (!covers(parsed, kinds, values)) continue;
      if (!rule.current && input.current && asksFor(input.current, parsed)) continue;
      return { rule, reason: citation(rule) };
    }
  return null;
}

/** How many memory items, and how many of the person's messages, are weighed, newest first. */
const MEMORY_RULES = 200;

/**
 * The person's rules for this job, from the three places that are theirs:
 * memory items they told Melete themselves, the agent's instructions, and
 * their own messages in this conversation, the current one last.
 */
export async function dontRulesFor(
  tx: Query,
  job: { id: string; space_id: string; principal_id?: string | null },
  attemptId: string | null | undefined,
): Promise<{ rules: DontRule[]; current: string | null }> {
  const rules: DontRule[] = [];
  const scope = await memoryScopeForSpace(tx, job.space_id, job.principal_id ?? null);
  if (scope) {
    const remembered = await tx`select x.content from memory_claims c
      join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
      join memory_revision_content x on x.claim_id = r.claim_id and x.revision = r.revision
      where c.space_id = ${job.space_id} and c.audience = ${scope.audience} and not c.hidden
        and r.status = 'active' and r.origin_trust = 'owner'
        and (r.valid_until is null or r.valid_until > now())
        and x.content ~* ${PROHIBIT_SQL}
      order by r.recorded_at desc limit ${MEMORY_RULES}`;
    for (const row of remembered) rules.push({ text: String(row.content), source: 'memory' });
  }
  const [agent] = await tx`select a.standing_instruction from job j
    join agent a on a.id = j.agent_id and a.space_id = j.space_id
    where j.id = ${job.id}`;
  if (agent?.standing_instruction)
    rules.push({ text: String(agent.standing_instruction), source: 'instruction' });
  // Only the person this job works for: in a room, someone else's message
  // neither sets their rules nor lifts one. Only an attempt the person is
  // waiting on answers their message: a later wake carries the same turn, but
  // what it does was not asked for by it, so the message cannot lift a rule.
  const author = job.principal_id ?? null;
  const [turn] = attemptId
    ? await tx`select t.id, t.text from attempt a
        join experience_turn t on t.id = a.turn_id and t.job_id = a.job_id
        where a.id = ${attemptId} and a.class = 'interactive' and t.author_principal_id is not null
          and (${author}::text is null or t.author_principal_id = ${author})`
    : [];
  const said = await tx`select id, text from experience_turn
    where job_id = ${job.id} and author_principal_id is not null
      and (${author}::text is null or author_principal_id = ${author})
    order by created_at desc, id desc limit ${MEMORY_RULES}`;
  for (const row of [...said].reverse())
    if (row.id !== turn?.id) rules.push({ text: String(row.text), source: 'conversation' });
  if (turn) rules.push({ text: String(turn.text), source: 'conversation', current: true });
  return { rules, current: turn ? String(turn.text) : null };
}
