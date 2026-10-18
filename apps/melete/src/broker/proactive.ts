/**
 * Work the agent takes on by itself, judged on what the person has said before.
 *
 * Proactive work is an attempt nobody is waiting on: a schedule, a timer or an
 * event woke it, not the person's message, answer or start (`attemptCause`,
 * recorded on the attempt as its class). When such work would reach someone
 * outside Melete, it is never asked about by default. It goes ahead on its
 * own when what the person said before makes it likely they want it, and it
 * is left as a quiet suggestion when not. The confidence is a plain sum over
 * evidence in their records, never the model's opinion:
 *
 * - an explicit standing instruction: the routine the person wrote, or the
 *   agent's instructions, saying to do this kind of thing (to this recipient,
 *   when it names one): +0.6;
 * - a stated preference: something the person told Melete themselves that
 *   names this recipient and this kind of thing: +0.3;
 * - a past similar action: the same kind of action to the same recipient in
 *   the last 90 days that the person asked for or allowed: +0.15 each, two at
 *   most;
 * - the person said no to, or took back, a similar action in that time: -0.5
 *   each;
 * - a recipient whose origin Melete cannot vouch for: the score is 0.
 *
 * Mail also needs the standing instruction itself: a preference and past
 * sends alone never send an email. Messages to others on chat apps follow
 * the same score, or, with `messages_to_others: draft_only`, are never sent
 * by proactive work.
 */
import type { JsonObject, JsonValue } from '@melete/contracts';
import { memoryScopeForSpace } from '../memory/broker-trust.ts';
import { type DontKind, KIND_WORDS, names, PROHIBIT, SENTENCES, targetsIn } from './dont-rules.ts';
import type { Query } from './records.ts';
import { collectOriginFields } from './trust.ts';

export const PROACTIVE_DEFAULT_THRESHOLD = 0.6;
export type MessagesToOthers = 'confidence' | 'draft_only';

export const WEIGHTS = {
  instruction: 0.6,
  preference: 0.3,
  past: 0.15,
  refused: -0.5,
} as const;
const PAST_COUNTED = 2;
const LOOKBACK_DAYS = 90;
const MEMORY_READ = 200;
const HISTORY_READ = 100;

export type Evidence = {
  kind: keyof typeof WEIGHTS;
  weight: number;
  /** What it is, in the person's terms, for the receipt. */
  says: string;
};

export type Confidence = {
  score: number;
  threshold: number;
  act: boolean;
  evidence: Evidence[];
  /** What would have let it go, when it does not. */
  missing: string[];
  /** Why it goes or is left, in one line for the receipt or the suggestion. */
  reason: string;
};

/**
 * A sentence that holds the action for the person rather than asking for it.
 * It errs towards holding: "without" or "nothing" anywhere is enough.
 */
const HOLDS =
  /\b(?:ask(?:s|ing)?|check(?:s|ing)? with|confirm(?:s|ing)? with|show(?:s|ing)?)\b[^.;]*\bbefore\b|\b(?:after|with|until) (?:a|my|your|their|the person'?s) (?:yes|ok|okay|approval|go-ahead)\b|\bfor (?:the person|me|them|you) to (?:send|post|reply)\b|\bonly (?:draft|suggest)\b|\bsuggest\b|\bwithout\b|\bnothing\b/i;

/** Argument names that say where a message goes, beyond the ones that choose a recipient. */
const REACHES =
  /^(?:channel|channel_id|chat_id|chat|thread|thread_ts|room|conversation|to_number|number)$/i;

/** Mail, as opposed to a chat app's message. */
export const sendsMail = (kind: string) =>
  /(?:^|[._])(?:e?mail|gmail|outlook|send_email|send_mail)(?:$|[._])/.test(kind.toLowerCase());

/** Whom or where an action reaches, lower case. */
export function reaches(payload: JsonObject, kind: string): string[] {
  const found = new Set<string>();
  for (const field of collectOriginFields(payload, kind))
    if (field.category === 'recipient' || field.category === 'destination')
      found.add(field.value.trim().toLowerCase());
  const walk = (value: JsonValue, depth: number) => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else
      for (const [key, nested] of Object.entries(value)) {
        if (REACHES.test(key) && (typeof nested === 'string' || typeof nested === 'number'))
          found.add(String(nested).trim().toLowerCase());
        walk(nested as JsonValue, depth + 1);
      }
  };
  walk(payload, 0);
  found.delete('');
  return [...found];
}

/** Words in a tool's name too general to say what it does. */
const GENERIC = new Set([
  'create',
  'update',
  'make',
  'send',
  'post',
  'item',
  'items',
  'tool',
  'action',
  'new',
  'run',
  'call',
  'execute',
  'perform',
  'with',
  'from',
  'into',
]);

/**
 * What the action is, in words a sentence would use: its kind ("email",
 * "reply", "book") and the particular words of its tool's name ("issue" for
 * `create_issue`, "invoice" for `send_invoice`).
 */
export type ActionWords = { kinds: readonly DontKind[]; tool: readonly string[] };

export function actionWords(kind: string, kinds: readonly DontKind[]): ActionWords {
  const verb = kind.slice(kind.indexOf('.') + 1);
  const tool = verb
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 4 && !GENERIC.has(word));
  return { kinds, tool };
}

const speaksOf = (sentence: string, words: ActionWords) =>
  words.kinds.some((kind) => KIND_WORDS[kind].test(sentence)) ||
  words.tool.some((word) => new RegExp(`\\b${word}(?:s|es)?\\b`, 'i').test(sentence));

/** The first sentence of `text` that asks for this kind of action, to these recipients when it names any. */
export function asksForIt(
  text: string,
  words: ActionWords,
  recipients: readonly string[],
): string | null {
  for (const sentence of text.replace(/[’‘]/g, "'").split(SENTENCES)) {
    if (PROHIBIT.test(sentence) || HOLDS.test(sentence)) continue;
    if (!speaksOf(sentence, words)) continue;
    // Roles ("my team") cannot be matched to an address, so they neither count nor exclude.
    const targets = targetsIn(sentence, { roles: false, skipFirst: true });
    if (targets.length === 0 || targets.some((target) => names(recipients, target)))
      return sentence.trim();
  }
  return null;
}

/** Whether `text` speaks well of this kind of action with one of these recipients. */
function prefers(text: string, words: ActionWords, recipients: readonly string[]) {
  for (const sentence of text.replace(/[’‘]/g, "'").split(SENTENCES)) {
    if (PROHIBIT.test(sentence) || HOLDS.test(sentence)) continue;
    if (!speaksOf(sentence, words)) continue;
    const targets = targetsIn(sentence, { roles: false });
    if (targets.some((target) => names(recipients, target))) return sentence.trim();
  }
  return null;
}

const quote = (text: string) => {
  const words = text.replace(/\s+/g, ' ').trim();
  return `“${words.length > 120 ? `${words.slice(0, 117)}…` : words}”`;
};

const day = (at: Date | string) =>
  new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The evidence for one proactive action, from the person's own records.
 * Read inside the broker's transaction, so it is the same at every phase.
 */
export async function gatherEvidence(
  tx: Query,
  input: {
    job: {
      id: string;
      space_id: string;
      principal_id?: string | null;
      objective?: string;
      objective_origin?: string | null;
    };
    action: { id: string; kind: string; canonical_payload: JsonObject };
    words: ActionWords;
  },
): Promise<Evidence[]> {
  const { job, action, words } = input;
  const recipients = reaches(action.canonical_payload, action.kind);
  const evidence: Evidence[] = [];

  // A standing instruction: the person's own routine, or the agent's instructions.
  const [agent] = await tx`select a.standing_instruction from job j
    join agent a on a.id = j.agent_id and a.space_id = j.space_id where j.id = ${job.id}`;
  const routine =
    job.objective_origin === 'owner_request' && job.objective
      ? asksForIt(job.objective, words, recipients)
      : null;
  const instructed = agent?.standing_instruction
    ? asksForIt(String(agent.standing_instruction), words, recipients)
    : null;
  if (routine)
    evidence.push({
      kind: 'instruction',
      weight: WEIGHTS.instruction,
      says: `your routine says ${quote(routine)}`,
    });
  else if (instructed)
    evidence.push({
      kind: 'instruction',
      weight: WEIGHTS.instruction,
      says: `its instructions say ${quote(instructed)}`,
    });

  // A stated preference, in something the person told Melete themselves.
  const scope = recipients.length
    ? await memoryScopeForSpace(tx, job.space_id, job.principal_id ?? null)
    : null;
  if (scope) {
    const patterns = [...new Set(recipients.flatMap(tokens))].map(
      (token) => `%${token.replace(/[\\%_]/g, '\\$&')}%`,
    );
    const remembered = patterns.length
      ? await tx`select x.content from memory_claims c
          join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
          join memory_revision_content x on x.claim_id = r.claim_id and x.revision = r.revision
          where c.space_id = ${job.space_id} and c.audience = ${scope.audience} and not c.hidden
            and r.status = 'active' and r.origin_trust = 'owner'
            and (r.valid_until is null or r.valid_until > now())
            and x.content ilike any(${patterns}::text[])
          order by r.recorded_at desc limit ${MEMORY_READ}`
      : [];
    for (const row of remembered) {
      const said = prefers(String(row.content), words, recipients);
      if (said) {
        evidence.push({
          kind: 'preference',
          weight: WEIGHTS.preference,
          says: `you told Melete ${quote(said)}`,
        });
        break;
      }
    }
  }

  // What the person did with actions like this one before.
  const history = await tx`select a.id, a.canonical_payload, a.created_at, a.status,
      coalesce((a.reconciliation->>'cancelled')::boolean, false) as cancelled,
      exists (select 1 from approval p join principal pr on pr.id = p.decided_by
        where p.action_id = a.id and p.decision = 'approved') as allowed,
      exists (select 1 from approval p join principal pr on pr.id = p.decided_by
        where p.action_id = a.id and p.decision = 'denied') as refused,
      exists (select 1 from attempt t join experience_turn u on u.id = t.turn_id
        where t.id = a.attempt_id and t.class = 'interactive'
          and u.author_principal_id is not null) as asked,
      exists (select 1 from activity_record r where r.action_id = a.id
        and r.undone_at is not null) as undone
    from action a join job j on j.id = a.job_id
    where j.space_id = ${job.space_id} and a.kind = ${action.kind} and a.id <> ${action.id}
      and a.created_at > now() - make_interval(days => ${LOOKBACK_DAYS})
    order by a.created_at desc limit ${HISTORY_READ}`;
  let past = 0;
  for (const row of history) {
    const theirs = reaches(row.canonical_payload as JsonObject, action.kind);
    const same =
      recipients.length === 0
        ? theirs.length === 0
        : theirs.some((value) => recipients.includes(value));
    if (!same) continue;
    const to = recipients.length ? ` to ${recipients[0]}` : '';
    if (row.refused || row.undone || row.cancelled)
      evidence.push({
        kind: 'refused',
        weight: WEIGHTS.refused,
        says: `you ${row.refused ? 'said no to' : 'took back'} a similar one${to} on ${day(row.created_at)}`,
      });
    else if (row.status === 'succeeded' && (row.allowed || row.asked) && past < PAST_COUNTED) {
      past++;
      evidence.push({
        kind: 'past',
        weight: WEIGHTS.past,
        says: `you ${row.allowed ? 'allowed' : 'asked for'} a similar one${to} on ${day(row.created_at)}`,
      });
    }
  }
  return evidence;
}

/**
 * Whether this attempt is proactive: nobody is waiting on it (`attemptCause`)
 * and something woke it: a trigger or a situation, or a timer after the work
 * rested. A job's own start is not a wake: work someone has just set going
 * (a job created through the API, a retry of its first shift) is judged as
 * before, so what is unsure of being a wake keeps the person's card.
 */
export async function proactiveAttempt(tx: Query, attemptId: string | null | undefined) {
  if (!attemptId) return false;
  const [row] = await tx`select a.class = 'background' and (
      a.trigger_id is not null or a.situation_id is not null
      or exists (select 1 from attempt p where p.job_id = a.job_id and p.epoch < a.epoch
        and p.outcome = 'waiting_for_event_or_time')) as woke
    from attempt a where a.id = ${attemptId}`;
  return row?.woke === true;
}

/** The words a recipient goes by: the whole of it and an address's name. */
function tokens(recipient: string): string[] {
  const value = recipient.toLowerCase();
  const at = value.indexOf('@');
  if (at <= 0) return [value.replace(/^[#@]/, '')].filter((token) => token.length >= 3);
  const local = value
    .slice(0, at)
    .split(/[._+-]+/)
    .filter((part) => part.length >= 3);
  return [value, ...local];
}

/**
 * The score and what it decides. `doubted` is a recipient whose origin
 * Melete cannot vouch for; `mail` an email, which needs the instruction itself;
 * `draftOnly` a chat-app message under `messages_to_others: draft_only`.
 */
export function judge(
  evidence: readonly Evidence[],
  options: { threshold: number; doubted: boolean; mail: boolean; draftOnly: boolean },
): Confidence {
  const sum = evidence.reduce((total, item) => total + item.weight, 0);
  const score = options.doubted ? 0 : Math.round(Math.min(1, Math.max(0, sum)) * 100) / 100;
  const instructed = evidence.some((item) => item.kind === 'instruction');
  const missing: string[] = [];
  if (options.doubted) missing.push('Melete cannot vouch for where its recipient came from');
  if (options.draftOnly) missing.push('messages to others are kept as drafts here');
  if (options.mail && !instructed)
    missing.push(
      'an email goes out on its own only when your routine or its instructions say to send it',
    );
  if (score < options.threshold && !options.doubted)
    missing.push(
      instructed
        ? 'what you said before does not add up to enough'
        : 'nothing you said asks for this, and there is no similar one you asked for or allowed',
    );
  const act =
    score >= options.threshold &&
    !options.doubted &&
    !options.draftOnly &&
    (!options.mail || instructed);
  const shown = score.toFixed(2);
  const because = evidence
    .filter((item) => item.weight > 0)
    .map((item) => item.says)
    .join('; ');
  const against = evidence
    .filter((item) => item.weight < 0)
    .map((item) => item.says)
    .join('; ');
  const reason = act
    ? // The receipt reads "Went ahead without asking you, because confidence is …".
      `Confidence is ${shown} from what you said before: ${because}.`
    : `Not sent, left as a suggestion (confidence ${shown}, it goes ahead on its own from ${options.threshold.toFixed(2)}): ${[...missing, against].filter(Boolean).join('; ')}.`;
  return { score, threshold: options.threshold, act, evidence: [...evidence], missing, reason };
}
