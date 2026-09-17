import { describe, expect, test } from 'bun:test';
import {
  BANNED_OPENERS,
  checkStyle,
  countQuestions,
  countSentences,
  replyClassOfEvidence,
  SENTENCE_BUDGET,
  styleViolation,
} from '@melete/contracts';
import { estimateTokens, IDENTITY_MAX_TOKENS, loadIdentity } from '@melete/skills';
import { runStyleCheck } from './check.ts';
import { BAD_SAMPLES, GOOD_SAMPLES } from './samples.ts';

describe('the reply-style check', () => {
  test('every sample gets the verdict written next to it', () => {
    const report = runStyleCheck();
    const failures = report.verdicts
      .filter((verdict) => !verdict.ok)
      .map(
        (verdict) =>
          `${verdict.sample.name}: expected [${verdict.sample.expect}], got [${verdict.actual}]`,
      );
    expect(failures).toEqual([]);
    expect(report.failed).toBe(0);
  });

  test('good samples produce no violations at all', () => {
    for (const sample of GOOD_SAMPLES) {
      expect(checkStyle(sample.text, { reply_class: sample.reply_class })).toEqual([]);
    }
  });

  test('bad samples produce violations that parse as the contract shape', () => {
    for (const sample of BAD_SAMPLES) {
      const violations = checkStyle(sample.text, { reply_class: sample.reply_class });
      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations)
        expect(styleViolation.parse(violation)).toEqual(violation);
    }
  });

  test('the check is deterministic: the same text twice gives the same answer', () => {
    for (const sample of [...GOOD_SAMPLES, ...BAD_SAMPLES]) {
      const first = checkStyle(sample.text, { reply_class: sample.reply_class });
      const second = checkStyle(sample.text, { reply_class: sample.reply_class });
      expect(second).toEqual(first);
    }
  });

  test('every banned opener is actually caught when it opens', () => {
    for (const opener of BANNED_OPENERS) {
      const violations = checkStyle(`${opener}, the engineer comes Thursday.`);
      expect(violations.map((v) => v.code)).toContain('banned_opener');
    }
  });

  test('casual is the default class, so an unlabelled reply gets the tight budget', () => {
    const four = 'One. Two. Three. Four.';
    expect(checkStyle(four).map((v) => v.code)).toEqual(['sentence_budget']);
    expect(checkStyle(four, { reply_class: 'detailed' })).toEqual([]);
  });

  test('a deliverable note has no sentence budget', () => {
    expect(SENTENCE_BUDGET.deliverable).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join(' ');
    expect(checkStyle(many, { reply_class: 'deliverable' })).toEqual([]);
  });

  test('empty text is not a violation; there is nothing to be wrong about', () => {
    expect(checkStyle('   ')).toEqual([]);
    expect(countSentences('')).toBe(0);
  });

  test('sentence and question counting ignore code', () => {
    expect(countSentences('One. Two.')).toBe(2);
    expect(countSentences('A fragment with no terminator')).toBe(1);
    expect(countSentences('```\nOne. Two. Three.\n```\nOne.')).toBe(1);
    expect(countQuestions('Why? `what?`')).toBe(1);
  });

  test('the reply class comes from the evidence, not from the prose', () => {
    expect(replyClassOfEvidence([{ kind: 'artifact' }])).toBe('deliverable');
    expect(replyClassOfEvidence([{ kind: 'action' }])).toBe('casual');
    expect(replyClassOfEvidence([])).toBe('casual');
  });
});

describe('the identity file', () => {
  const identity = loadIdentity();
  /** The file is hard-wrapped; the rules it states are not about line breaks. */
  const flat = identity.replace(/\s+/g, ' ');

  test('is inside the 250-token cap it loads on every attempt against', () => {
    expect(estimateTokens(identity)).toBeLessThanOrEqual(IDENTITY_MAX_TOKENS);
    expect(estimateTokens(identity)).toBeLessThanOrEqual(250);
  });

  test('states the reply rules the style check measures', () => {
    expect(flat).toContain('Answer first');
    expect(flat).toContain('One to three sentences');
    expect(flat).toContain('No preamble');
    expect(flat).toContain('never call yourself an AI');
    expect(flat).toContain('Contractions are fine');
    expect(flat).toContain('Ask one question at a time');
    expect(flat).toContain('A deliverable is an artifact');
  });

  test('states the receipt rule and the stop rule', () => {
    expect(flat).toContain('Say it succeeded when there is a receipt');
    expect(flat).toContain('cannot confirm it when there is none');
    expect(flat).toContain('spends money');
    expect(flat).toContain('cannot be undone');
    expect(flat).toContain('rests on a disputed fact');
    expect(flat).toContain('a source you do not trust');
  });

  test('tells the model to name prior work in one clause', () => {
    expect(flat).toContain('Refer to prior work in one clause');
  });

  test('keeps a social reply short, drops disclaimers and offers, and reports only what changed', () => {
    expect(flat).toContain('one short sentence or a reaction');
    expect(flat).toContain('Never add that nothing is pending');
    expect(flat).toContain('never close with an offer');
    expect(flat).toContain('Cite a source only when asked or when a fact is disputed');
    expect(flat).toContain('report only what changed');
  });

  test('does not itself open with anything the style check bans', () => {
    expect(checkStyle(identity, { reply_class: 'deliverable' })).toEqual([]);
  });
});
