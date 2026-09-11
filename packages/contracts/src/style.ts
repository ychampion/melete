/**
 * The reply-style check.
 *
 * The identity file tells the model how to talk. Prose in a prompt is a wish,
 * not a property, so this module turns the four rules that can be decided
 * without judgment into a function: no canned opener, a sentence budget for the
 * class of reply, one question mark at most, and no describing yourself as an
 * AI. Everything else about voice stays in the identity file where it belongs.
 *
 * The check never blocks. It is recorded on the attempt's context record as
 * `style_violations`, which makes drift measurable across releases instead of
 * arguable. A deterministic rule that cannot be gamed by rewording is worth more
 * than a model grading its own manners.
 */
import { z } from 'zod';

/**
 * How much room a reply has earned. `casual` is the default: the person said
 * something and wants an answer. `detailed` is what they get when they asked
 * for detail. `deliverable` is the text that accompanies an artifact, and it
 * carries no sentence budget because the budget belongs to the artifact.
 */
export const REPLY_CLASSES = ['casual', 'detailed', 'deliverable'] as const;
export const replyClass = z.enum(REPLY_CLASSES);
export type ReplyClass = z.infer<typeof replyClass>;

/** Sentences a class may spend. `null` is unbounded, not large. */
export const SENTENCE_BUDGET: Record<ReplyClass, number | null> = {
  casual: 3,
  detailed: 12,
  deliverable: null,
};

/**
 * Openers that say nothing. Each is matched at the start of the reply only,
 * case-insensitively, after leading whitespace and markdown decoration; a
 * sentence that happens to contain "of course" in the middle is prose, not a
 * preamble.
 */
export const BANNED_OPENERS = [
  'absolutely',
  'as an ai',
  'certainly',
  'excellent question',
  'good question',
  'great question',
  "i'd be happy to",
  'i would be happy to',
  'i can certainly',
  'i can help with that',
  'i can help you',
  'happy to help',
  'let me help',
  'let me start by',
  'no problem',
  'of course',
  'sure thing',
  'thanks for asking',
  'thank you for asking',
  'that is a great',
  "that's a great",
  'to answer your question',
  'you are absolutely right',
  "you're absolutely right",
] as const;

/** Ways of naming yourself as a machine. The person knows; saying it is filler. */
const AI_SELF_REFERENCE =
  /\b(?:as an ai\b|as a language model\b|i am an ai\b|i'm an ai\b|i am a language model\b|i'm a language model\b|as an artificial intelligence\b|being an ai\b)/i;

export const STYLE_VIOLATION_CODES = [
  'banned_opener',
  'sentence_budget',
  'multiple_questions',
  'ai_self_reference',
] as const;
export const styleViolationCode = z.enum(STYLE_VIOLATION_CODES);
export type StyleViolationCode = z.infer<typeof styleViolationCode>;

/** One recorded observation. `detail` names the exact thing that tripped it. */
export const styleViolation = z.strictObject({
  code: styleViolationCode,
  detail: z.string().min(1).max(300),
});
export type StyleViolation = z.infer<typeof styleViolation>;

/** The bounded list a context record carries. Measured, never enforced. */
export const styleViolations = z.array(styleViolation).max(64).default([]);

/** Strip the decoration a model puts in front of its first word. */
const openerOf = (text: string): string =>
  text
    .replace(/^[\s>*_#`-]+/u, '')
    .replace(/^["'“”‘’]+/u, '')
    .toLowerCase();

/**
 * Count sentences the only way two processes can agree on: a run of terminal
 * punctuation ends one, and a fragment with no terminator still counts as a
 * sentence because it is still something the person has to read. Code fences
 * and their contents are removed first, since a snippet is not prose.
 */
export function countSentences(text: string): number {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .trim();
  if (!prose) return 0;
  return prose
    .split(/[.!?]+(?=\s|$)/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/** Question marks outside code, so a snippet containing one is not a question. */
export function countQuestions(text: string): number {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  return (prose.match(/\?/g) ?? []).length;
}

export type StyleCheckOptions = {
  /** Defaults to `casual`, which is the class most replies actually are. */
  reply_class?: ReplyClass;
};

/**
 * Everything wrong with one piece of outgoing assistant text, in a stable
 * order. An empty array is the only passing answer; the caller decides what to
 * do with a non-empty one, and in v0.1 the answer is "write it down".
 */
export function checkStyle(text: string, options: StyleCheckOptions = {}): StyleViolation[] {
  const klass = options.reply_class ?? 'casual';
  const violations: StyleViolation[] = [];
  const trimmed = text.trim();
  if (!trimmed) return violations;

  const opener = openerOf(trimmed);
  const matched = BANNED_OPENERS.find((phrase) => opener.startsWith(phrase));
  if (matched) violations.push({ code: 'banned_opener', detail: matched });

  const budget = SENTENCE_BUDGET[klass];
  const sentences = countSentences(trimmed);
  if (budget !== null && sentences > budget) {
    violations.push({
      code: 'sentence_budget',
      detail: `${sentences} sentences in a ${klass} reply; the budget is ${budget}`,
    });
  }

  const questions = countQuestions(trimmed);
  if (questions > 1) {
    violations.push({ code: 'multiple_questions', detail: `${questions} question marks` });
  }

  const selfReference = AI_SELF_REFERENCE.exec(trimmed);
  if (selfReference) {
    violations.push({ code: 'ai_self_reference', detail: selfReference[0].toLowerCase() });
  }

  return violations;
}

/**
 * Which class an attempt's own text belongs to, decided from records rather
 * than from how the text reads. An outcome that cites an artifact is a
 * deliverable and its prose is a covering note; everything else is casual until
 * a caller says otherwise, because that is the class with the tightest budget
 * and the safest default is to measure against it.
 */
export function replyClassOfEvidence(evidence: readonly { kind: string }[]): ReplyClass {
  return evidence.some((item) => item.kind === 'artifact') ? 'deliverable' : 'casual';
}
