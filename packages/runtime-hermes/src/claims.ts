/**
 * What a reply says it did, held against what the turn's tools did.
 *
 * A reply can say "I've sent it", "I booked the table" or "I checked in my
 * browser" when no tool in the turn sent, booked or opened a browser: the
 * model describes the step it meant to take as the step it took. The person
 * takes the sentence as done. This finds those sentences without a model, so
 * the same reply and the same tools always give the same answer.
 *
 * Two kinds of claim are checked:
 *
 * - delivery: a file attached or saved, a message sent, something added to
 *   the person's calendar or list, a booking made, something closed or
 *   cancelled;
 * - method: work said to be done in the agent's browser or on a page.
 *
 * Each family names the tools whose call backs it. The patterns are
 * deliberately narrow and in the past tense ("I've sent", "has been booked"):
 * an offer ("I can send it"), a plan ("I'll book it") and a negation ("I
 * haven't sent it") are not claims. Quoted lines and code blocks are someone
 * else's words (a draft's text), and are left alone.
 *
 * At the end of an attempt the adapter asks the engine once, out of the
 * person's sight, to either do what it said or say it without the claim. What
 * still claims an undone step when the turn is saved is taken out by the
 * service, sentence by sentence, from the actions that succeeded in the turn;
 * an attached file that is not there gets its own note instead
 * (`experience/delivery-claims.ts`).
 */

export type ClaimFamily = 'attached' | 'saved' | 'sent' | 'added' | 'booked' | 'closed' | 'browser';

export type Claim = { family: ClaimFamily; sentence: string };

const I = String.raw`\bI(?:'ve|’ve| have| just| now)?(?: just| now| already| also)?`;

/** The agent saying it attached a file to this reply. */
export const CLAIMS_ATTACHED: readonly RegExp[] = [
  new RegExp(String.raw`${I} attached\b`, 'i'),
  /\b(?:file|pdf|document|spreadsheet|image|picture|chart|copy|list|report|it)s? (?:is|are|has been|have been) attached\b/i,
  /\battached (?:below|here|above|to this (?:reply|message))\b/i,
];

type Family = {
  family: ClaimFamily;
  says: readonly RegExp[];
  /** A tool or action kind that, called in the turn, backs the claim. */
  backedBy: RegExp;
};

const FAMILIES: readonly Family[] = [
  {
    family: 'attached',
    says: CLAIMS_ATTACHED,
    backedBy:
      /^(?:files\.(?:write|move|save_attachment)|artifact\.publish|audio\.(?:synthesize|transcribe))$/,
  },
  {
    family: 'saved',
    says: [
      new RegExp(
        String.raw`${I} saved (?:it|them|that|this|everything|a copy|the (?:file|pdf|document|list|note|notes|report|draft|spreadsheet))\b`,
        'i',
      ),
      new RegExp(
        String.raw`${I} saved\b[^.!?\n]*\b(?:to|in|into|under) (?:your|the) (?:files|drive|documents|notes|folder|downloads|memory)\b`,
        'i',
      ),
      /\b(?:it|file|document|copy|list|note|report|spreadsheet)s? (?:is|are|has been|have been) saved (?:to|in|as)\b/i,
    ],
    backedBy:
      /^(?:files|artifact|memory|notes|documents?|drive)\.|(?:save|write|upload|create|publish)/,
  },
  {
    family: 'sent',
    says: [
      new RegExp(String.raw`${I} (?:sent|emailed|texted|messaged|forwarded)\b`, 'i'),
      /\b(?:email|e-mail|message|text|invite|invitation|reply|it) (?:has been|was|is now) (?:sent|delivered)\b/i,
    ],
    backedBy: /(?:send|reply|forward|post|publish|share|invite|resume_action)/,
  },
  {
    family: 'added',
    says: [
      new RegExp(
        String.raw`(?:${I} added|\b(?:has been|was|is now) added)\b[^.!?\n]*\bto your (?:calendar|schedule|list|shopping list|cart|basket|notes|tasks|to-?do|reminders|contacts|sheet|spreadsheet|board)\b`,
        'i',
      ),
      new RegExp(String.raw`${I} put (?:it|this|that)\b[^.!?\n]*\b(?:on|in) your calendar\b`, 'i'),
    ],
    backedBy:
      /(?:create|add|insert|append|update|write|calendar\.|tasks?\.|todo|cart|contacts?\.|browser\.(?:click|submit|fill)|computer\.)/,
  },
  {
    family: 'booked',
    says: [
      new RegExp(String.raw`${I} (?:booked|reserved|purchased|bought)\b`, 'i'),
      /\b(?:table|appointment|room|flight|ticket|reservation|booking|order|slot|it)s? (?:is|are|has been|have been) (?:booked|reserved|placed|ordered)\b/i,
    ],
    backedBy:
      /(?:book|reserv|order|buy|purchase|pay|checkout|calendar\.create|browser\.(?:click|submit)|computer\.(?:click|type|key|batch))/,
  },
  {
    family: 'closed',
    says: [
      new RegExp(
        String.raw`${I} (?:closed|cancell?ed|archived|deleted|unsubscribed)\b[^.!?\n]*\b(?:it|them|account|subscription|order|booking|reservation|appointment|ticket|issue|emails?|messages?|event|meeting|tab|plan|membership)\b`,
        'i',
      ),
      /\b(?:account|subscription|order|booking|reservation|ticket|issue|it) (?:has been|was|is now) (?:closed|cancell?ed|archived|deleted)\b/i,
    ],
    backedBy:
      /(?:close|cancel|archive|delete|unsubscribe|discard|remove|browser\.(?:click|submit)|computer\.(?:click|key|batch))/,
  },
  {
    family: 'browser',
    says: [
      /\b(?:in|using|with|through|from) my (?:own )?(?:web )?browser\b/i,
      new RegExp(
        String.raw`${I} (?:opened|visited|loaded|went to|browsed|checked|looked at|scrolled|clicked)\b[^.!?\n]*\b(?:the|their|its|this|that) (?:web)?(?:page|site|website)\b`,
        'i',
      ),
      /\bon the (?:web)?page (?:itself )?(?:I|it) (?:showed|said|listed|read)\b/i,
    ],
    backedBy: /^(?:browser|computer)\.|^web\.fetch$|browser|navigate/,
  },
];

/** A sentence ends at . ! or ?, but not after a title or a common abbreviation ("Dr. Rao"). */
const SENTENCE_END =
  /(?<!\b(?:Dr|Mr|Mrs|Ms|Mx|St|Jr|Sr|vs|etc|e\.g|i\.e|No|Inc|Ltd|Co)\.)(?<=[.!?])\s+/;

/** The reply's own sentences: quoted lines and code blocks are someone else's words. */
function ownSentences(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*>/.test(line)) continue;
    out.push(...line.split(SENTENCE_END).filter((sentence) => sentence.trim()));
  }
  return out;
}

/** A message drafted or sent in the turn may itself say "attached"; its text is not a claim. */
const WRITES_MESSAGES = /^(?:email|mail|message|slack|chat|sms)\./;

/**
 * The claims in `text` that no tool in `called` backs, in reading order, one
 * per sentence. `called` is every tool or action kind the turn ran.
 */
export function unbackedClaims(text: string, called: readonly string[]): Claim[] {
  const claims: Claim[] = [];
  const drafted = called.some((kind) => WRITES_MESSAGES.test(kind));
  for (const sentence of ownSentences(text)) {
    for (const family of FAMILIES) {
      if (family.family === 'attached' && drafted) continue;
      if (!family.says.some((pattern) => pattern.test(sentence))) continue;
      if (called.some((kind) => family.backedBy.test(kind))) continue;
      claims.push({ family: family.family, sentence: sentence.trim() });
      break;
    }
  }
  return claims;
}

const WHAT: Record<ClaimFamily, string> = {
  attached: 'attaching a file',
  saved: 'saving something',
  sent: 'sending something',
  added: 'adding something to their calendar or a list',
  booked: 'booking, ordering or paying for something',
  closed: 'closing, cancelling or deleting something',
  browser: 'working in your browser or on a page',
};

/**
 * The one continuation an attempt gets when its reply claims a step no tool in
 * it took: do the step now, or say the reply again without the claim.
 */
export function claimsContinuation(claims: readonly Claim[]): string {
  const said = claims
    .slice(0, 3)
    .map((claim) => `"${claim.sentence.slice(0, 200)}" (${WHAT[claim.family]})`)
    .join('; ');
  return (
    `Your reply says you did something no tool in this turn did: ${said}. ` +
    'If it is still worth doing and you can, do it now with the right tool. Otherwise do not ' +
    'claim it. Then write your whole reply to the person again, saying only what was actually ' +
    'done and how. Do not mention this check.'
  );
}

/**
 * The reply without the sentences that still claim an undone step. Attached
 * files are left to their own note. A reply that would be left with nothing is
 * returned as it was.
 */
export function withoutUnbackedClaims(text: string, called: readonly string[]): string {
  const doomed = new Set(
    unbackedClaims(text, called)
      .filter((claim) => claim.family !== 'attached')
      .map((claim) => claim.sentence),
  );
  if (doomed.size === 0) return text;
  let fenced = false;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*(?:```|~~~)/.test(line) || /^\s*>/.test(line)) {
      lines.push(line);
      continue;
    }
    const kept = line.split(SENTENCE_END).filter((sentence) => !doomed.has(sentence.trim()));
    const joined = kept.join(' ');
    // A line that held only a removed claim goes; a list marker left alone goes too.
    if (line.trim() && !joined.replace(/^\s*(?:[-*+]|\d+[.)])\s*$/, '').trim()) continue;
    lines.push(joined);
  }
  const result = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return result ? result : text;
}
