/**
 * Claims against receipts. A reply that says something was attached, sent,
 * saved, booked or done "in my browser" must have a step or a receipt of that
 * family behind it. This flags the ones that have none. It reads sentence by
 * sentence, and passes over sentences that deny, offer or plan rather than
 * report ("I couldn't attach it", "I can send it", "I'll book it once you say").
 */
import type { ExperienceReceipt, ResultCard, ToolCall } from '@melete/contracts';
import type { Claim } from './types.ts';

export type ClaimEvidence = {
  tools: Pick<ToolCall, 'kind' | 'title' | 'status'>[];
  receipts: Pick<ExperienceReceipt, 'what' | 'where'>[];
  cards: Pick<ResultCard, 'title' | 'primary_action' | 'secondary_actions'>[];
};

type Rule = {
  kind: Claim['kind'];
  pattern: RegExp;
  wanted: string;
  backed: (evidence: ClaimEvidence) => boolean;
};

const done = (evidence: ClaimEvidence, test: (tool: ClaimEvidence['tools'][number]) => boolean) =>
  evidence.tools.some((tool) => tool.status === 'done' && test(tool));

/** A file the person can open or download, in the chat. */
const fileCard = (evidence: ClaimEvidence) =>
  evidence.cards.some((card) =>
    [card.primary_action, ...card.secondary_actions].some(
      (action) => action && (action.kind === 'download' || action.kind === 'open'),
    ),
  );
const savedFile = (evidence: ClaimEvidence) =>
  fileCard(evidence) ||
  done(evidence, (tool) => tool.kind === 'artifact') ||
  done(
    evidence,
    (tool) => tool.kind === 'file' && /^(Wrote|Moved|Saved|Restored)\b/.test(tool.title),
  );
/** A step that changed something outside the conversation: a page, a command, an app. */
const acted = (evidence: ClaimEvidence) =>
  evidence.receipts.length > 0 ||
  done(evidence, (tool) => ['browser', 'sandbox', 'connector'].includes(tool.kind));
const browsed = (evidence: ClaimEvidence) =>
  done(
    evidence,
    (tool) =>
      tool.kind === 'browser' ||
      (tool.kind === 'sandbox' &&
        /^(Opened|Clicked|Typed|Scrolled|Pressed|Did a few steps|Took a screenshot)\b/.test(
          tool.title,
        )),
  );
const sentSomething = (evidence: ClaimEvidence) =>
  evidence.receipts.some((receipt) => /\b(sent|send|email|message|text)\b/i.test(receipt.what)) ||
  done(evidence, (tool) => tool.kind === 'connector' && /^Sent\b/.test(tool.title));

const RULES: Rule[] = [
  {
    kind: 'delivery',
    pattern:
      /\b(?:is|are|have|has been|it's|i've|i have)?\s*attached\b|\battached (?:it|the|a|your)\b|\bhere(?:'s| is) (?:the|your) (?:file|pdf|document|spreadsheet)\b/i,
    wanted: 'a file card with Open or Download, or a saved file step',
    backed: savedFile,
  },
  {
    kind: 'delivery',
    pattern:
      /\b(?:saved|put|added|moved|uploaded) (?:it |them |the [\w .-]+ )?(?:to|in|into) (?:your|my) (?:files|folder|drive)\b|\bin your files\b/i,
    wanted: 'a file card with Open or Download, or a saved file step',
    backed: savedFile,
  },
  {
    kind: 'delivery',
    pattern:
      /\b(?:i(?:'ve| have)? )?(?:sent|emailed|texted|messaged) (?:it|you|them|the|a|an|your|him|her)\b/i,
    wanted: 'a send receipt or a done send step',
    backed: sentSomething,
  },
  {
    kind: 'action',
    pattern:
      /\b(?:i(?:'ve| have)? )?(?:booked|ordered|purchased|bought|paid|transferred|submitted|registered|signed up|placed (?:the|your|an|a) order|created (?:the|an|a|your) (?:issue|account|employee|order|booking)|closed (?:the|it|issue)|logged (?:in|out)|downloaded)\b/i,
    wanted: 'a done browser, computer or app step, or a receipt',
    backed: acted,
  },
  {
    kind: 'method',
    pattern:
      /\b(?:in|with|using|through|via) (?:my|the|its) (?:own )?browser\b|\bbrowsed\b|\bopened (?:it|the page|the site) in\b/i,
    wanted: 'a done browser step, or a page opened or used on its computer',
    backed: browsed,
  },
  {
    kind: 'method',
    pattern: /\bsearched (?:the web|online|google)\b/i,
    wanted: 'a done web search',
    backed: (evidence) => done(evidence, (tool) => tool.kind === 'web'),
  },
  {
    kind: 'method',
    pattern: /\b(?:ran|run) (?:a |the )?(?:command|script)\b|\bin (?:a|the|my) terminal\b/i,
    wanted: 'a done command on its computer',
    backed: (evidence) => done(evidence, (tool) => tool.kind === 'sandbox'),
  },
];

/** A sentence that denies, conditions, offers or plans is not a report of something done. */
const NOT_A_REPORT =
  /\b(?:not|n't|never|no longer|unable|couldn|cannot|can't|wasn't|failed|instead of|if you|once you|would you|want me|shall i|should i|i can|i could|i'll|i will|i would|i'd|i'm going|going to|let me know|ready to|before (?:you|i)|until)\b/i;

/** Splits on sentence ends and line breaks, keeping list items as their own sentences. */
export function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.replace(/^[\s>*\-•\d.)]+/, '').trim())
    .filter(Boolean);
}

/** Every claim in `reply` that names an action or a method no step or receipt backs. */
export function unsupportedClaims(reply: string, evidence: ClaimEvidence): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of sentences(reply)) {
    if (NOT_A_REPORT.test(sentence) || sentence.endsWith('?')) continue;
    for (const rule of RULES) {
      const match = sentence.match(rule.pattern);
      if (!match || rule.backed(evidence)) continue;
      claims.push({
        kind: rule.kind,
        phrase: match[0].trim(),
        sentence: sentence.slice(0, 300),
        wanted: rule.wanted,
      });
      break;
    }
  }
  return claims;
}
