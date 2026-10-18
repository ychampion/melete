/**
 * Words about the agent's own workings, left in a reply to the person.
 *
 * A model often opens with what it is about to do ("Let me check the
 * forecast…", "I'll read the remember-this skill…") and sometimes ends there.
 * The person asked a question; the line about the next step is not an answer,
 * and a skill is the agent's own business, not theirs. This finds those lines
 * without a model, so the same reply always gives the same answer:
 *
 * - an opening line that only announces the next step: "Let me", "I'll" or
 *   "I'm going to" with a verb of looking or reading, trailing off ("…") or
 *   followed by the answer, and naming no time, so a promise ("I'll check
 *   again tomorrow at 9") is kept;
 * - any line about reading, loading or using a skill.
 *
 * Quoted lines and code are someone else's words, and are left alone. A reply
 * that would be left empty is kept whole: `onlyNarration` says so, and the
 * adapter asks the engine, once, for the reply itself.
 */

const PREAMBLE =
  /^(?:(?:ok(?:ay)?|alright|sure|great|got it)[,!.]?\s+)?(?:let me|i['’]ll|i will|i['’]m going to|i am going to|i['’]m|i am)\s+(?:now\s+|first\s+|quickly\s+|just\s+|go\s+(?:and\s+)?)?(?:check(?:ing)?|look(?:ing)?|read(?:ing)?|load(?:ing)?|open(?:ing)?|search(?:ing)?|run(?:ning)?|call(?:ing)?|us(?:e|ing)|fetch(?:ing)?|pull(?:ing)?|grab(?:bing)?|find(?:ing)?|get(?:ting)?|review(?:ing)?|verify(?:ing)?|start(?:ing)?|see|take a look)\b/i;

/** A time in the line makes it a promise about later, not a note about now. */
const LATER =
  /\b(?:tomorrow|tonight|later|again|next|every|each|when|once|after|before|by|until|at \d|in \d+|on (?:mon|tue|wed|thu|fri|sat|sun))/i;

const SKILL =
  /\b(?:read|reading|load|loading|loaded|use|using|used|open|opening|follow|following|check|checking|view|viewing)\b[^.!?…]{0,60}\bskills?\b/i;

/** Ends at . ! ? … or a colon, but not after a title or a common abbreviation. */
const LINE_END =
  /(?<!\b(?:Dr|Mr|Mrs|Ms|Mx|St|Jr|Sr|vs|etc|e\.g|i\.e|No|Inc|Ltd|Co)\.)(?<=[.!?…:])\s+/;

const trailsOff = (sentence: string) => /(?:…|\.\.\.|:)\s*$/.test(sentence);

function isOpening(sentence: string, rest: boolean): boolean {
  const said = sentence.trim();
  if (!PREAMBLE.test(said) || LATER.test(said) || said.length > 160) return false;
  return trailsOff(said) || rest;
}

/** The reply with the lines about its own workings taken out; whole if that leaves nothing. */
export function withoutNarration(text: string): string {
  let fenced = false;
  let opening = true;
  const lines: string[] = [];
  const all = text.split('\n');
  for (const [index, line] of all.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*(?:```|~~~)/.test(line) || /^\s*>/.test(line)) {
      if (line.trim()) opening = false;
      lines.push(line);
      continue;
    }
    const sentences = line.split(LINE_END);
    const later = all.slice(index + 1).some((next) => next.trim());
    const kept = sentences.filter((sentence, at) => {
      if (SKILL.test(sentence)) return false;
      if (!opening || !sentence.trim()) return true;
      const rest = later || sentences.slice(at + 1).some((next) => next.trim());
      if (isOpening(sentence, rest)) return false;
      opening = false;
      return true;
    });
    const joined = kept.join(' ');
    if (line.trim() && !joined.trim()) continue;
    lines.push(joined);
  }
  const result = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!result) return text;
  return result === text.trim() ? text : result.charAt(0).toUpperCase() + result.slice(1);
}

/** A reply that is nothing but lines about the agent's own workings. */
export function onlyNarration(text: string): boolean {
  if (!text.trim()) return false;
  let fenced = false;
  const all = text.split('\n');
  for (const line of all) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*(?:```|~~~)/.test(line) || /^\s*>/.test(line)) {
      if (line.trim()) return false;
      continue;
    }
    for (const sentence of line.split(LINE_END)) {
      const said = sentence.trim();
      if (!said) continue;
      if (SKILL.test(said)) continue;
      if (PREAMBLE.test(said) && !LATER.test(said) && said.length <= 160) continue;
      return false;
    }
  }
  return true;
}

/**
 * Whether words already sent in a turn are its answer rather than a line about
 * what came next: more than nothing-but-narration, and more than one short
 * sentence, which may only announce the next step in other words ("Checking
 * what I know about your book club."). A short answer reads as a line here;
 * the cost is one more ask to say only what is new, never a turn left with no
 * answer.
 */
export function answersAlready(said: string): boolean {
  if (onlyNarration(said)) return false;
  const kept = withoutNarration(said).trim();
  const sentences = kept.split(/\n+|(?<=[.!?…])\s+/).filter((part) => part.trim()).length;
  return sentences >= 2 || kept.length > 160;
}
