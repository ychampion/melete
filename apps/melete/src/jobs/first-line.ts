/**
 * The first line of a conversation turn is said once.
 *
 * A turn can open two ways: the service's acknowledgement
 * (`experience/ack.ts`), shown when the agent is still silent at the deadline,
 * or the agent's own line on what it is about to do. Each gives way to the
 * other:
 *
 * - The agent's words that arrive before the acknowledgement is shown win: the
 *   acknowledgement is dropped, even when it is already written.
 * - Once the acknowledgement is shown, the agent's opening is held until it is
 *   known what it is. The agent's model request was often already on its way
 *   when the line was shown, so it could not be told, and a line saying what
 *   it is about to do would say the same thing twice. Such a line is dropped:
 *   the agent's first words, when they read as a plan ("Drafting the reply to
 *   Sam.") and end at its next step or at the end of their line. Anything else
 *   is the answer, and goes out as it came, a moment later. Only the opening is
 *   judged, once; a whole reply is never dropped.
 * - A turn can run as several attempts (it waited on a step, an approval or a
 *   retry). When an earlier attempt showed the acknowledgement and nothing has
 *   been said since, the agent's first words in a later attempt are the first
 *   the person reads after the line, so they are judged the same way, after
 *   any steps that come first.
 *
 * The runtime's events keep their order and their sequence numbers: a dropped
 * line goes out as empty text, so the record has no gap. A line dropped from
 * the reply the attempt ends on is left out of its saved answer too, so a page
 * read later shows what the person saw live.
 *
 * What reads as a plan is English: a line in another language is never
 * dropped, so at worst the person reads two first lines.
 */
import type { AttemptOutcome, RuntimeEvent } from '@melete/contracts';

/** A plan line is one or two short sentences; past this, held text is the answer. */
export const OPENING_MAX_CHARACTERS = 200;

/** Events that show the agent has moved on to work: what it wrote first was its plan. */
const WORK = new Set<RuntimeEvent['type']>([
  'tool_call_proposed',
  'tool_result',
  'action_requested',
  'turn_started',
]);

/** A few words a person says before getting on with it: "Sure —", "On it.", "Got it,". */
const LEAD_IN =
  /^(?:sure|okay|ok|got it|on it|alright|all right|of course|no problem|will do|right|great|good question|happy to help)\b[\s,.!—–-]*/i;

/**
 * Words in -ing that open a line without being the agent at work: "Nothing
 * changed", "Meeting moved to 3", "According to the ECB", "Interesting".
 */
const NOT_AT_WORK = new Set([
  'according',
  'amazing',
  'anything',
  'boring',
  'bring',
  'ceiling',
  'confusing',
  'during',
  'evening',
  'everything',
  'exciting',
  'existing',
  'funding',
  'including',
  'incoming',
  'interesting',
  'king',
  'meeting',
  'missing',
  'morning',
  'nothing',
  'ongoing',
  'outgoing',
  'parking',
  'pending',
  'pricing',
  'regarding',
  'remaining',
  'ring',
  'shipping',
  'sing',
  'something',
  'spring',
  'sting',
  'string',
  'surprising',
  'swing',
  'thing',
  'things',
  'timing',
  'upcoming',
  'wedding',
  'wing',
]);

/** A second word that makes the first one the subject of a sentence: "Booking confirmed". */
const STATES =
  /^(?:is|are|was|were|has|have|had|will|would|can|could|should|may|might|must|does|did|do|isn't|aren't|wasn't|won't|can't|[a-z]+ed)$/;

/** The agent saying what it will do: "I'll", "Let me", "I'm going to", "I'm checking". */
const INTENT = /^(?:let me|let's|i'll|i will|i'm going to|i am going to)\s/i;
const INTENT_ING = /^(?:i'm|i’m|i am)\s+[a-z]+ing\b/i;

/**
 * A time of day or a stretch of time: "7:14 AM", "9 pm", "3 minutes", "the
 * 22nd". Inside a statement of intent it is a detail of the plan ("I'll set a
 * timer for 7:14 AM"), not a result; any other number may be the answer.
 */
const TIME =
  /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?=[\s,.!?]|$)|\b\d{1,2}:\d{2}\b|\b\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b|\b\d{1,2}(?:st|nd|rd|th)\b/gi;

/** Words that say when, in a detail after a comma: "three minutes from now". */
const WHEN =
  /\b(?:now|today|tonight|tomorrow|morning|afternoon|evening|noon|midnight|later|soon|seconds?|minutes?|hours?|days?|weeks?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|TIME)\b/i;

/** How a detail about when can start: a time, a count, or a word like "in" or "by". */
const WHEN_START =
  /^(?:TIME|in|at|by|on|for|from|around|about|within|until|before|after|right|first|now|today|tonight|tomorrow|this|next|every|a|an|half|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|sixty|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/**
 * Words that make a clause a statement of fact or a condition rather than a
 * detail of the plan: "it is a bad deal", "but the rate is 1.08", "since the
 * form asks for it", "here's the draft".
 */
const FACT =
  /\b(?:is|are|was|were|be|been|isn't|aren't|wasn't|weren't|it's|that's|there's|here's|here|has|have|had|hasn't|haven't|does|did|doesn't|didn't|because|since|but|so|although|though|unless|if|which|who|whose|when|while|whereas|yet|however|otherwise|found|shows|says|said|means|looks|seems|costs|came|got|returned)\b/i;

/** A detail after a comma that keeps a sentence a plan: a time, or more of the same plan. */
function planDetail(part: string): boolean {
  if (FACT.test(part)) return false;
  // "then check the word count", "and I'll tell you": the plan goes on. Not
  // "then the rate fell": a subject after "then" starts a statement.
  if (
    /^(?:and\s+)?then\s+(?!(?:the|a|an|it|its|they|he|she|we|you|that|this|there|your|my)\b)[a-z]/i.test(
      part,
    )
  )
    return true;
  if (INTENT.test(part.replace(/^and\s+/i, ''))) return true;
  // "three minutes from now", "TIME": when, and nothing else.
  return part.split(/\s+/).length <= 8 && WHEN_START.test(part) && WHEN.test(part);
}

/**
 * A statement of intent with a detail after a comma: "I'll set a timer for
 * 7:14 AM, three minutes from now." It stays a plan only when the whole of it
 * is intent: no number other than a time (a number may be the answer), no
 * "here is", no colon or semicolon outside a time, and every part after a
 * comma a time or more of the plan. Anything else is content.
 */
function intentWithDetail(text: string): boolean {
  if (!INTENT.test(text) && !INTENT_ING.test(text)) return false;
  if (/^let me know\b/i.test(text)) return false;
  const doing = /^(?:i'm|i am)\s+([a-z]+ing)\b/i.exec(text)?.[1];
  if (doing && NOT_A_STEP.has(doing.toLowerCase())) return false;
  const masked = text.replace(TIME, ' TIME ').replace(/[.!?…]+$/, '');
  if (/[:;]/.test(masked)) return false;
  if (/\bhere(?:'s|’s|\s+is|\s+are)\b/i.test(masked)) return false;
  if (/[\d$€£¥%]/.test(masked)) return false;
  const [head = '', ...rest] = masked.split(',').map((part) => part.trim());
  if (!head || /\b(?:but|because|since|though|although|unless)\b/i.test(head)) return false;
  return rest.length > 0 && rest.every((part) => part !== '' && planDetail(part));
}

/**
 * Words that report what was found, what went wrong or how things stand,
 * rather than what comes next: "I'm getting an error from the site", "Finding
 * nothing for that date", "Leaving at 7 is safest", "Booking it would cost".
 */
const REPORT =
  /\b(?:not|no|nothing|none|never|can't|cannot|couldn't|won't|didn't|doesn't|don't|isn't|aren't|wasn't|weren't|error|errors|failed|failing|fails|trouble|problem|problems|blocked|denied|unavailable|is|are|was|were|would|costs?|works?|meant|means|running into|ran into)\b/i;

/** The agent's state or a guess, not its next step: "I'm seeing two fares", "I'm guessing Thursday". */
const NOT_A_STEP = new Set([
  'seeing',
  'thinking',
  'guessing',
  'assuming',
  'noticing',
  'hearing',
  'wondering',
  'leaning',
  'missing',
  'having',
]);

/** "I'll need your address", "I'll be honest": a request or a remark, not a step. */
const INTENT_STATE = /^(?:let me|i'll|i will)\s+(?:need|have to|be|want)\b/i;

/** The -ing word that opens a line about the agent at work, if it is one. */
function workVerb(text: string): string | null {
  const intent = /^(?:i'm|i’m|i am)\s+([a-z]+ing)\b/i.exec(text);
  if (intent) return (intent[1] as string).toLowerCase();
  const [first = '', second = ''] = text.split(/\s+/);
  const verb = first.replace(/[^A-Za-z]/g, '');
  if (!/^[A-Z][a-z]+ing$/.test(verb) || NOT_AT_WORK.has(verb.toLowerCase())) return null;
  return STATES.test(second.toLowerCase().replace(/[^a-z']/g, '')) ? null : verb.toLowerCase();
}

/**
 * "Setting a timer for 7:53 AM so I can remind you to stretch.": a step, a
 * time whose colon is the time's own, and why the agent takes it, in a few
 * words that report nothing. A time read back with no such reason ("Setting
 * your reminder for 9:37 pm.") is said.
 */
function stepWithPurpose(text: string): boolean {
  const masked = text.replace(TIME, ' TIME ').replace(/[.!?…]+$/, '');
  if (!masked.includes('TIME') || /[:;,]/.test(masked)) return false;
  const [head = '', purpose, ...more] = masked.split(
    /\bso (?:that )?I(?:'ll| can| could| will)\s+/i,
  );
  if (purpose === undefined || more.length || !head.includes('TIME')) return false;
  if (purpose.split(/\s+/).length > 10 || FACT.test(purpose)) return false;
  const verb = workVerb(head);
  return INTENT.test(head) || (verb !== null && !NOT_A_STEP.has(verb));
}

/** One sentence of a plan: the agent saying what it is doing or will do. */
function planSentence(sentence: string): boolean {
  const text = sentence.replace(LEAD_IN, '').trim();
  // "On it." alone says nothing beyond the line already shown.
  if (!text) return true;
  // A number other than a time, or a word that reports what was found or how
  // things stand, makes it an answer however it opens.
  const masked = text.replace(TIME, ' TIME ');
  if (/[\d$€£¥%]/.test(masked) || REPORT.test(masked)) return false;
  if (INTENT_STATE.test(text)) return false;
  if (stepWithPurpose(text)) return true;
  // A colon, a semicolon or a comma carries a fact or a condition: content,
  // unless the sentence is all intent and the comma adds when it happens.
  if (/[:;,]/.test(text)) return intentWithDetail(text);
  if (/^let me know\b/i.test(text)) return false;
  if (INTENT.test(text)) return true;
  const verb = workVerb(text);
  return verb !== null && !NOT_A_STEP.has(verb);
}

/**
 * A line that says what the agent is about to do: "Checking the ECB rate.",
 * "Drafting the cover letter. I'll check the word count first.", "Let me look
 * up the forecast.", "Sure — I'll set that reminder now." One or two short
 * sentences, each of them a plan. It fails toward content: a line it is not
 * sure of is said.
 */
export function isPlanLine(line: string): boolean {
  const text = line.replace(/’/g, "'").trim();
  if (!text || text.length > OPENING_MAX_CHARACTERS) return false;
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  return sentences.length <= 2 && sentences.every(planSentence);
}

type State =
  /** The acknowledgement may still be shown. */
  | 'waiting'
  /** It is being written into the record now; everything waits for it. */
  | 'showing'
  /** It was shown, and the agent's opening is held until it is known. */
  | 'holding'
  /** Nothing more to decide: every event goes out as it comes. */
  | 'open';

const textOf = (event: RuntimeEvent): string => (event.type === 'text_delta' ? event.text : '');

export class FirstLine {
  private state: State;
  private held: RuntimeEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** Settles when the acknowledgement being written has been shown, or not. */
  private shown: Promise<void> = Promise.resolve();
  private settleShown = () => {};
  /**
   * A plan line dropped from the start of the agent's latest message, while
   * no step has followed it: if that message is the reply the attempt ends on,
   * its saved copy leaves the line out too.
   */
  private cut: string | null = null;

  /**
   * `pass` records one event, in order. With `acknowledging` false there is
   * no acknowledgement to wait for, and every event goes straight through.
   * With `acknowledged`, an earlier attempt of this turn showed the line and
   * nothing has been said since: this attempt's opening is held and judged
   * from its start.
   */
  constructor(
    private readonly pass: (event: RuntimeEvent) => Promise<void>,
    acknowledging: boolean,
    acknowledged = false,
  ) {
    this.state = acknowledged ? 'holding' : acknowledging ? 'waiting' : 'open';
  }

  /** The agent has said nothing yet, and the acknowledgement may still be shown. */
  get silent(): boolean {
    return this.state === 'waiting';
  }

  /**
   * The acknowledgement is about to be written. False when the agent has
   * spoken first or the acknowledgement was called off: then it is not shown.
   * Every true is followed by `endShow`.
   */
  beginShow(): boolean {
    if (this.state !== 'waiting') return false;
    this.state = 'showing';
    this.shown = new Promise<void>((resolve) => {
      this.settleShown = resolve;
    });
    return true;
  }

  /** The acknowledgement was written, or was not and the agent's words go out as they came. */
  endShow(shown: boolean): Promise<void> {
    this.settleShown();
    if (this.state !== 'showing') return Promise.resolve();
    if (!shown) {
      this.state = 'open';
      return this.release(this.held.length);
    }
    this.state = 'holding';
    return this.decide();
  }

  /** No acknowledgement will be shown for this turn from now on. */
  cancel(): void {
    if (this.state === 'waiting') this.state = 'open';
  }

  /** One runtime event; held while the opening is undecided. */
  emit(event: RuntimeEvent): Promise<void> {
    if (this.state === 'open') return this.enqueue(event);
    if (this.state === 'waiting') {
      // The agent's own words come first: the acknowledgement gives way.
      if (textOf(event).trim()) this.state = 'open';
      return this.enqueue(event);
    }
    this.held.push(event);
    return this.state === 'showing' ? Promise.resolve() : this.decide();
  }

  /**
   * The attempt is ending: a line being shown is waited for, so it comes
   * before what the agent said and the opening is judged against it; then
   * what is still held goes out as it came (the whole of a short reply), and
   * every event handed in has been recorded (or failed) when this resolves.
   */
  async drain(): Promise<void> {
    if (this.state === 'waiting') this.state = 'open';
    if (this.state === 'showing') await this.shown;
    if (this.state === 'holding' || this.state === 'showing') {
      this.state = 'open';
      await this.release(this.held.length);
    }
    await this.chain;
  }

  /**
   * The attempt's outcome as the person saw it: a plan line dropped from the
   * start of the reply it ends on is left out of the reply's saved copy.
   */
  settled(outcome: AttemptOutcome): AttemptOutcome {
    const cut = this.cut;
    if (!cut) return outcome;
    const trimmed = (text: string) => {
      const start = text.trimStart();
      return start.startsWith(cut) ? start.slice(cut.length).trimStart() : text;
    };
    if ('summary' in outcome) return { ...outcome, summary: trimmed(outcome.summary) };
    if ('draft' in outcome && typeof outcome.draft === 'string')
      return { ...outcome, draft: trimmed(outcome.draft) };
    return outcome;
  }

  /** Looks at what is held, in order, and lets it go once the opening is known. */
  private decide(): Promise<void> {
    const released: Promise<void>[] = [];
    let text = '';
    let index = 0;
    const done = (count: number) => {
      this.state = 'open';
      released.push(this.release(count));
      return Promise.all(released).then(() => undefined);
    };
    while (index < this.held.length) {
      const event = this.held[index] as RuntimeEvent;
      if (event.type === 'attempt_outcome') {
        // The whole reply was this text: it is the answer, never dropped.
        return done(this.held.length);
      }
      if (WORK.has(event.type)) {
        const opening = text.trim();
        if (!opening) {
          // A model call or a step before any words: those go out now, and the
          // agent's first words after them are still judged, so a plan line in
          // a response already on its way is not said twice.
          released.push(this.release(index + 1));
          index = 0;
          text = '';
          continue;
        }
        // The agent's first words, up to its next step, said what the line said.
        if (isPlanLine(opening)) this.blank(index, '');
        return done(this.held.length);
      }
      text += textOf(event);
      const opening = text.trimStart();
      const lineEnd = opening.search(/\n\s*\S/);
      if (lineEnd >= 0) {
        const line = opening.slice(0, lineEnd).trim();
        if (isPlanLine(line)) {
          this.blank(index + 1, opening.slice(lineEnd).trimStart());
          this.cut = line;
        }
        return done(this.held.length);
      }
      if (opening.length > OPENING_MAX_CHARACTERS) return done(this.held.length);
      index++;
    }
    return Promise.all(released).then(() => undefined);
  }

  /** Replaces the text of the first `count` held events with `rest`, put in the first one. */
  private blank(count: number, rest: string): void {
    let placed = false;
    for (let index = 0; index < count; index++) {
      const event = this.held[index];
      if (event?.type !== 'text_delta') continue;
      this.held[index] = { ...event, text: placed ? '' : rest };
      placed = true;
    }
  }

  private release(count: number): Promise<void> {
    return Promise.all(this.held.splice(0, count).map((event) => this.enqueue(event))).then(
      () => undefined,
    );
  }

  /** Each event is recorded after the one before it; one that fails does not stop the next. */
  private enqueue(event: RuntimeEvent): Promise<void> {
    // A step after the dropped line: the message it opened was not the last one.
    if (WORK.has(event.type)) this.cut = null;
    const out =
      event.type === 'attempt_outcome' ? { ...event, outcome: this.settled(event.outcome) } : event;
    const recorded = this.chain.then(() => this.pass(out));
    this.chain = recorded.catch(() => undefined);
    return recorded;
  }
}
