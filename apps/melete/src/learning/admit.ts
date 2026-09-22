/**
 * Admission for a model-authored procedure.
 *
 * A procedure body is instruction text that will later be delivered to a model
 * as a skill, so text derived from a correction is a durable prompt-injection
 * surface and, because a body can be shared, a way to launder private prose.
 * Nothing here trusts the proposal: every step is anchored byte-exactly to a
 * span of the owner's own words, every content word must descend either from
 * that span or from a closed procedural vocabulary, a deny scan removes
 * addresses, paths, tool syntax and long digit runs, an authority scan removes
 * the language of permission, and the body itself is assembled by this file
 * from a fixed preamble and numbered step text. The model's bytes are never
 * passed through.
 *
 * Changing the preamble, the vocabulary, the stemmer or either scan invalidates
 * every stored definition at its next verification. That is intended: it is
 * what makes a stored body mean what a reviewer reads here.
 */
import {
  normalizeForMatch,
  type ProcedureCheck,
  type ProcedureStep,
  type ProcedureStepEvidence,
  type ProcedureTrigger,
  procedureProposal,
} from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { EMAIL } from '../memory/tier0.ts';

export const MAX_STEPS = 6;
export const MAX_STEP_CHARS = 240;
export const MAX_TRIGGERS = 4;
export const MAX_TRIGGER_CHARS = 60;
export const MAX_CHECKS = 6;
export const MAX_VARIANTS = 4;
export const MAX_BODY_TOKENS = 400;
/** The rule below examines only words at least this long; shorter ones carry no content alone. */
export const CONTENT_WORD_LENGTH = 4;

export const PROCEDURE_PREAMBLE =
  "Follow these steps for this kind of task. They are the owner's own instructions, not permissions.";

/** A step whose paraphrase was not supported keeps the owner's words instead. */
export const verbatimStep = (quote: string) => `Owner's correction: "${quote}"`;

export class AdmissionError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
function refuse(reason: string, message: string): never {
  throw new AdmissionError(reason, message);
}

// --------------------------------------------------------------------------
// Deterministic light stemming
// --------------------------------------------------------------------------

const SUFFIXES = ['ing', 'est', 'ed', 'ly', 'er', 'es', 's'] as const;
const DOUBLED = /([bdfglmnprt])\1$/;

/**
 * Enough to let an honest paraphrase through: "sorted" and "sort", "bullets"
 * and "bullet", "shorter" and "short", "dropping" and "drop" have to compare
 * equal or the rule rejects nearly every real proposal. Each pass strips one
 * suffix (or turns a final "ies" into "y", or drops a final "e"), and passes
 * repeat until nothing changes, so "number" and "numbers" agree rather than
 * stopping one strip apart. No lexicon and no library: stored definitions are
 * verified against this function, so it must stem the same word the same way
 * on every machine for as long as those definitions live.
 */
export function stem(word: string): string {
  let value = word.toLowerCase();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = value;
    if (value.length >= 5 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
    else {
      for (const suffix of SUFFIXES) {
        if (!value.endsWith(suffix)) continue;
        const remainder = value.slice(0, -suffix.length);
        if (remainder.length < 3) continue;
        value = DOUBLED.test(remainder) ? remainder.slice(0, -1) : remainder;
        break;
      }
      if (value === before && value.length >= 4 && value.endsWith('e')) value = value.slice(0, -1);
    }
    if (value === before) return value;
  }
  return value;
}

// --------------------------------------------------------------------------
// The closed vocabularies
// --------------------------------------------------------------------------

/**
 * Neutral words a procedure may use even when the owner did not say them:
 * function words, quantities, the names of shapes a piece of writing can take,
 * and plain procedural verbs. Nothing here names a person, a place, a product
 * or a credential, and no entry shares a stem with any word of the authority
 * list, which a test asserts. Only base forms are listed; membership is decided
 * on stems, so inflections follow without lengthening the list. Words shorter
 * than four letters are absent because the rule never examines them.
 */
export const PROCEDURE_WORDS = [
  // function words and connectives
  'that',
  'this',
  'these',
  'those',
  'them',
  'their',
  'there',
  'then',
  'than',
  'with',
  'from',
  'into',
  'onto',
  'when',
  'while',
  'where',
  'which',
  'what',
  'after',
  'before',
  'each',
  'every',
  'both',
  'other',
  'another',
  'same',
  'such',
  'only',
  'also',
  'just',
  'here',
  'they',
  'have',
  'been',
  'being',
  'will',
  'would',
  'should',
  'must',
  'could',
  'does',
  'done',
  'about',
  'instead',
  'rather',
  'unless',
  'either',
  'because',
  'like',
  'make',
  'sure',
  'nothing',
  // quantities and ordering words
  'first',
  'last',
  'next',
  'later',
  'more',
  'less',
  'most',
  'least',
  'over',
  'under',
  'above',
  'below',
  'maximum',
  'minimum',
  'count',
  'total',
  'half',
  'single',
  'double',
  'many',
  'limit',
  'range',
  'exact',
  'some',
  'none',
  'once',
  'again',
  'part',
  'ascending',
  'descending',
  'oldest',
  // shape and structure
  'bullet',
  'point',
  'list',
  'number',
  'paragraph',
  'sentence',
  'heading',
  'section',
  'table',
  'column',
  'rows',
  'line',
  'title',
  'subject',
  'summary',
  'draft',
  'reply',
  'message',
  'greeting',
  'closing',
  'tone',
  'formal',
  'casual',
  'plain',
  'short',
  'brief',
  'long',
  'length',
  'detail',
  'format',
  'order',
  'blank',
  'space',
  'word',
  'character',
  'label',
  'item',
  'step',
  'note',
  'link',
  'quote',
  'date',
  'time',
  'name',
  'value',
  'text',
  'body',
  'answer',
  'question',
  'header',
  'mark',
  'style',
  'form',
  'file',
  'page',
  'source',
  'record',
  'type',
  'numeric',
  'alphabetical',
  'chronological',
  'original',
  'result',
  // procedural verbs
  'keep',
  'kept',
  'write',
  'wrote',
  'written',
  'start',
  'begin',
  'finish',
  'include',
  'exclude',
  'omit',
  'leave',
  'avoid',
  'never',
  'remove',
  'delete',
  'sort',
  'group',
  'split',
  'merge',
  'check',
  'confirm',
  'read',
  'compare',
  'prefer',
  'shorten',
  'expand',
  'translate',
  'cite',
  'mention',
  'repeat',
  'replace',
  'show',
  'give',
  'move',
  'change',
  'follow',
  'match',
  'apply',
  'state',
  'open',
  'close',
  'return',
  'report',
  'arrange',
  'preserve',
  'stop',
] as const;

/**
 * A procedure never grants permission. These terms are the vocabulary of doing
 * so, whether the correction was written by the owner or pasted into it by
 * someone else, and a single hit refuses the whole proposal.
 */
export const AUTHORITY_TERMS = [
  'approve',
  'approval',
  'approved',
  'permission',
  'permissions',
  'grant',
  'granted',
  'credential',
  'credentials',
  'password',
  'secret',
  'token',
  'api key',
  'bypass',
  'override',
  'ignore previous',
  'ignore prior',
  'system prompt',
  'without asking',
  "don't ask",
  'do not ask',
  'skip confirmation',
  'auto-approve',
  'always allow',
  'no confirmation',
  'on my behalf',
  'sudo',
  'admin',
] as const;
export const AUTHORITY_MESSAGE =
  'A procedure never grants permission; standing permissions are set in the permission system.';

const PROCEDURE_STEMS = new Set(PROCEDURE_WORDS.map(stem));

const DENY_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['url', /https?:\/\//i],
  ['url', /\bwww\./i],
  // The tier-0 pattern is global; a fresh non-global copy keeps `test` free of lastIndex state.
  ['email', new RegExp(EMAIL.source)],
  ['path', /(^|\s)(\/|[A-Za-z]:\\|\.\.?\/)/],
  ['path', /\.(ts|js|json|md|sh|exe|dll|env)\b/i],
  ['syntax', /[`<>{}]/],
  ['syntax', /\$\(/],
  ['syntax', /\]\(/],
  ['digits', /\d{5,}/],
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  ['control', /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/],
];

/** Names what kind of content was refused, never the content itself. */
export function denyScan(text: string): string | null {
  for (const [what, pattern] of DENY_PATTERNS) if (pattern.test(text)) return what;
  return null;
}

const escaped = (term: string) =>
  term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
const AUTHORITY_PATTERNS = AUTHORITY_TERMS.map(
  (term) =>
    [term, new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(term)}($|[^\\p{L}\\p{N}])`, 'iu')] as const,
);

/** Whole words and phrases, case-insensitive. Returns the first term found. */
export function authorityScan(text: string): string | null {
  for (const [term, pattern] of AUTHORITY_PATTERNS) if (pattern.test(text)) return term;
  return null;
}

// --------------------------------------------------------------------------
// The word-subset rule
// --------------------------------------------------------------------------

const contentWords = (text: string) =>
  (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word.length >= CONTENT_WORD_LENGTH);

/**
 * Every content word of a step has to have come from somewhere: the owner's own
 * quote, or the procedural vocabulary. A word from neither is novel content (a
 * name, a value, an instruction nobody gave) and the step may not carry it.
 * Returns the first such word, or null when every word is supported.
 */
export function unsupportedWord(text: string, quote: string): string | null {
  const supported = new Set(contentWords(quote).map(stem));
  for (const word of contentWords(text)) {
    const root = stem(word);
    if (!supported.has(root) && !PROCEDURE_STEMS.has(root)) return word;
  }
  return null;
}

/** Deny scan and authority scan, in that order, over one piece of text. */
function scan(text: string, where: string) {
  const denied = denyScan(text);
  if (denied) refuse(`denied_token:${denied}`, `${where} carries refused content.`);
  const authority = authorityScan(text);
  if (authority) refuse(`authority_language:${authority}`, AUTHORITY_MESSAGE);
}

// --------------------------------------------------------------------------
// Compilation
// --------------------------------------------------------------------------

export type ProposalSource = {
  id: 'intervention' | 'objective';
  /** Where `text` starts in the whole source, so a truncated segment keeps whole-source spans. */
  offset: number;
  text: string;
};

/** Trusted bytes. The preamble and the numbering are ours; only step text varies. */
export function compileBody(steps: readonly { text: string }[]) {
  if (!steps.length) refuse('too_few_steps', 'A procedure needs at least one step.');
  if (steps.length > MAX_STEPS) refuse('too_many_steps', 'A procedure has at most six steps.');
  for (const step of steps) {
    if (step.text.length > MAX_STEP_CHARS)
      refuse('step_too_long', 'A procedure step is at most 240 characters.');
    scan(step.text, 'A procedure step');
  }
  const body = [
    PROCEDURE_PREAMBLE,
    ...steps.map((step, index) => `${index + 1}. ${step.text}`),
  ].join('\n');
  if (estimateTokens(body) > MAX_BODY_TOKENS)
    refuse('procedure_token_limit', 'The compiled procedure is longer than a skill may be.');
  // The numbered lines, one at a time. The separators and the preamble are ours (the
  // preamble names permissions in order to disclaim them), and a newline inside a step
  // was refused above.
  for (const line of body.split('\n').slice(1)) scan(line, 'The compiled procedure');
  return body;
}

export const GENERAL_TESTS = ['checks'] as const;
export const GENERAL_BENEFIT = 'Fewer owner corrections on requests this procedure applies to.';
export const GENERAL_RISK =
  'A procedure learned from one correction may not suit every request that matches its triggers.';

export type GeneralChange = {
  target: 'skill_body';
  steps: ProcedureStep[];
  variant_objectives: string[];
};
export type AdmittedProcedure = {
  change: GeneralChange;
  body: string;
  triggers: ProcedureTrigger[];
  checks: ProcedureCheck[];
  evidence: ProcedureStepEvidence[];
  tests: string[];
  predictedBenefit: string;
  knownRisk: string;
};

/** A4, with the verbatim fallback: the step as written, or the owner's quote, or nothing. */
function supportedStep(text: string, evidence: ProcedureStepEvidence): ProcedureStep {
  const { fallback: _ignored, ...span } = evidence;
  if (!unsupportedWord(text, span.quote)) return { text, evidence: span };
  const verbatim = verbatimStep(span.quote);
  if (verbatim.length > MAX_STEP_CHARS)
    refuse('step_not_supported_by_quote', 'A procedure step uses a word the owner did not.');
  return { text: verbatim, evidence: { ...span, fallback: 'verbatim' } };
}

function supportedTrigger(phrase: string, evidence: ProcedureStepEvidence): ProcedureTrigger {
  if (phrase.length > MAX_TRIGGER_CHARS)
    refuse('trigger_too_long', 'A trigger phrase is at most 60 characters.');
  // Punctuation normalises away, and a trigger with no words would name every request.
  if (!normalizeForMatch(phrase))
    refuse('trigger_without_words', 'A trigger phrase needs words to match.');
  scan(phrase, 'A trigger');
  scan(evidence.quote, 'A trigger quote');
  if (unsupportedWord(phrase, evidence.quote))
    refuse('step_not_supported_by_quote', 'A trigger uses a word the owner did not.');
  return { phrase, evidence };
}

/**
 * Re-runs every content rule over an already stored definition. Nothing about
 * the episode is needed, so it is cheap enough to call at every delivery: what
 * it proves is that the stored body and triggers are still what these rules
 * produce from the stored steps and quotes.
 */
export function compileStoredProcedure(raw: unknown, triggers: readonly unknown[] = []) {
  const change = storedChange(raw);
  for (const step of change.steps) {
    scan(step.text, 'A procedure step');
    scan(step.evidence.quote, 'A procedure quote');
    // What this step's text must be, given how it was admitted. A stored fallback is
    // the owner's quote wrapped by trusted code; anything else must still pass the
    // word rule. Re-deciding which branch applies would refuse a fallback whose quote
    // happens to contain the wrapper's own words ("owner", "correction"), which is a
    // coincidence of stemming, not tampering.
    const expected =
      step.evidence.fallback === 'verbatim'
        ? verbatimStep(step.evidence.quote)
        : supportedStep(step.text, step.evidence).text;
    if (expected !== step.text)
      refuse('step_not_supported_by_quote', 'A stored step is not what its quote supports.');
  }
  if (triggers.length > MAX_TRIGGERS) refuse('too_many_triggers', 'At most four triggers.');
  for (const trigger of triggers) {
    const value = trigger as Partial<ProcedureTrigger>;
    if (typeof value?.phrase !== 'string' || typeof value.evidence?.quote !== 'string')
      refuse('definition_shape_invalid', 'A stored trigger is missing its phrase or evidence.');
    supportedTrigger(value.phrase, value.evidence);
  }
  return { change, body: compileBody(change.steps), tests: [...GENERAL_TESTS] };
}

/** The stored shape, checked structurally rather than trusted from the database. */
function storedChange(raw: unknown): GeneralChange {
  const value = raw as { target?: unknown; steps?: unknown; variant_objectives?: unknown };
  if (value?.target !== 'skill_body' || !Array.isArray(value.steps))
    refuse('definition_shape_invalid', 'The stored procedure is not a step list.');
  const steps = (value.steps as Partial<ProcedureStep>[]).map((step) => {
    if (typeof step?.text !== 'string' || typeof step.evidence?.quote !== 'string')
      refuse('definition_shape_invalid', 'A stored step is missing its text or its evidence.');
    return step as ProcedureStep;
  });
  const variants = Array.isArray(value.variant_objectives)
    ? (value.variant_objectives as unknown[]).filter((item) => typeof item === 'string')
    : [];
  for (const variant of variants) scan(variant, 'A variant objective');
  return { target: 'skill_body', steps, variant_objectives: variants as string[] };
}

// --------------------------------------------------------------------------
// Admission
// --------------------------------------------------------------------------

function sliceSpan(
  span: { source: string; start: number; end: number; quote: string },
  sources: readonly ProposalSource[],
) {
  const source = sources.find((entry) => entry.id === span.source);
  if (!source) refuse('span_outside_source', 'A span cites a source that was not supplied.');
  if (
    span.start >= span.end ||
    span.start < source.offset ||
    span.end - source.offset > source.text.length
  )
    refuse('span_outside_source', 'A span lies outside the text that was supplied.');
  if (source.text.slice(span.start - source.offset, span.end - source.offset) !== span.quote)
    refuse('span_not_verbatim', 'The quoted text is not what the source holds at those offsets.');
}

/**
 * The admission rules, in order. The spans are verified before anything is
 * read from them; the deny and authority scans run over each step and its quote
 * before the word rule, so injected content is refused as what it is rather
 * than being carried forward as a verbatim fallback. Whether the checks tell
 * the corrected answer from the objected one needs the episode's recorded
 * outputs and runs after this.
 */
export function admitProposal(
  raw: unknown,
  context: { sources: readonly ProposalSource[]; objective: string; bundledSuite?: boolean },
): AdmittedProcedure {
  const parsed = procedureProposal.safeParse(raw);
  if (!parsed.success)
    refuse('proposal_schema_invalid', 'The proposal does not match the procedure schema.');
  const proposal = parsed.data;

  const steps = proposal.steps.map((step) => {
    sliceSpan(step.evidence, context.sources);
    scan(step.text, 'A procedure step');
    scan(step.evidence.quote, 'A procedure quote');
    return supportedStep(step.text, step.evidence);
  });

  const objective = normalizeForMatch(context.objective);
  const triggers = proposal.triggers.map((trigger) => {
    sliceSpan(trigger.evidence, context.sources);
    const admitted = supportedTrigger(trigger.phrase, trigger.evidence);
    if (!objective.includes(normalizeForMatch(trigger.phrase)))
      refuse('trigger_not_in_objective', 'A trigger must appear in the objective it selects on.');
    return admitted;
  });

  if (proposal.checks.length > MAX_CHECKS)
    refuse('check_unsupported', 'A procedure declares at most six checks.');
  for (const check of proposal.checks) {
    if (check.kind === 'records_expected_order' && !context.bundledSuite)
      refuse('check_unsupported', 'Only a bundled suite may assert fixture row identities.');
    // Punctuation normalises away, and an empty phrase is found in every output.
    const phrases = 'phrase' in check ? [check.phrase] : 'headings' in check ? check.headings : [];
    if (phrases.some((phrase) => !normalizeForMatch(phrase)))
      refuse('check_unsupported', 'A check phrase has no words to match.');
    // A check phrase never reaches a delivered body, but it is stored and shown to
    // the owner, so it is held to the same content rules as the rest of the proposal.
    for (const value of [
      ...phrases,
      ...('key' in check ? [check.key] : []),
      ...('action_kind' in check ? [check.action_kind] : []),
    ])
      scan(value, 'A check phrase');
  }

  const variants = proposal.variant_objectives.map((variant) => {
    if (denyScan(variant) || authorityScan(variant))
      refuse('variant_objective_denied', 'A variant objective carries refused content.');
    const normalized = normalizeForMatch(variant);
    if (normalized === objective)
      refuse('variant_objective_denied', 'A variant may not repeat the source objective.');
    if (!triggers.some((trigger) => normalized.includes(normalizeForMatch(trigger.phrase))))
      refuse('variant_objective_denied', 'A variant must match a trigger this procedure declares.');
    return variant;
  });

  const body = compileBody(steps);
  return {
    change: { target: 'skill_body', steps, variant_objectives: variants },
    body,
    triggers,
    checks: proposal.checks,
    evidence: [...steps.map((step) => step.evidence), ...triggers.map((item) => item.evidence)],
    tests: [...GENERAL_TESTS],
    predictedBenefit: GENERAL_BENEFIT,
    knownRisk: GENERAL_RISK,
  };
}

/**
 * The spans once more, against the source text itself. A body that recompiles
 * from its stored quotes proves nothing about whether those quotes are still
 * the owner's words at those offsets; re-slicing does.
 */
export function verifyStoredEvidence(
  spans: readonly ProcedureStepEvidence[],
  sources: readonly ProposalSource[],
) {
  for (const span of spans) sliceSpan(span, sources);
}
