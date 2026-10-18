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
 *   what the agent wrote before its first step, or a one-sentence plan line
 *   ("Drafting the reply to Sam.") before the rest of its answer. Anything else
 *   is the answer, and goes out as it came, a moment later.
 *
 * The runtime's events keep their order and their sequence numbers: a dropped
 * line goes out as empty text, so the record has no gap.
 */
import type { RuntimeEvent } from '@melete/contracts';

/** A plan line is one short sentence; past this, held text is the answer. */
export const OPENING_MAX_CHARACTERS = 200;

/** Events that show the agent has moved on to work: what it wrote first was its plan. */
const WORK = new Set<RuntimeEvent['type']>([
  'tool_call_proposed',
  'tool_result',
  'action_requested',
  'turn_started',
]);

/**
 * A line that says what the agent is about to do: "Checking the ECB rate.",
 * "Drafting the cover letter.", "Let me look up the forecast.", "I'll set
 * that reminder now." One sentence, opening with a verb in -ing or with the
 * agent saying what it will do.
 */
export function isPlanLine(line: string): boolean {
  const text = line.trim();
  if (!text || text.length > OPENING_MAX_CHARACTERS) return false;
  // One sentence: a second one is content, not a plan.
  if (/[.!?…:;]\s+\S/.test(text)) return false;
  const first = text.split(/\s+/)[0]?.replace(/[^A-Za-z']/g, '') ?? '';
  return /^[A-Z][a-z]+ing$/.test(first) || /^(?:let me|i'll|i will|i'm going to)\b/i.test(text);
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

  /**
   * `pass` records one event, in order. With `acknowledging` false there is
   * no acknowledgement to wait for, and every event goes straight through.
   */
  constructor(
    private readonly pass: (event: RuntimeEvent) => Promise<void>,
    acknowledging: boolean,
  ) {
    this.state = acknowledging ? 'waiting' : 'open';
  }

  /** The agent has said nothing yet, and the acknowledgement may still be shown. */
  get silent(): boolean {
    return this.state === 'waiting';
  }

  /**
   * The acknowledgement is about to be written. False when the agent has
   * spoken first or the acknowledgement was called off: then it is not shown.
   */
  beginShow(): boolean {
    if (this.state !== 'waiting') return false;
    this.state = 'showing';
    return true;
  }

  /** The acknowledgement was written, or was not and the agent's words go out as they came. */
  endShow(shown: boolean): Promise<void> {
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
   * The attempt is ending: what is still held goes out as it came, and every
   * event handed in has been recorded (or failed) when this resolves.
   */
  async drain(): Promise<void> {
    if (this.state === 'waiting') this.state = 'open';
    if (this.state === 'holding' || this.state === 'showing') {
      this.state = 'open';
      await this.release(this.held.length);
    }
    await this.chain;
  }

  /** Looks at what is held, in order, and lets it go once the opening is known. */
  private decide(): Promise<void> {
    let text = '';
    for (const [index, event] of this.held.entries()) {
      if (event.type === 'attempt_outcome') {
        // The whole reply was this text: it is the answer, never dropped.
        this.state = 'open';
        return this.release(this.held.length);
      }
      if (WORK.has(event.type)) {
        this.state = 'open';
        // What the agent wrote before its first step said what the line said.
        const opening = text.trim();
        if (opening && opening.length <= OPENING_MAX_CHARACTERS) this.blank(index, '');
        return this.release(this.held.length);
      }
      text += textOf(event);
      const opening = text.trimStart();
      const lineEnd = opening.search(/\n\s*\S/);
      if (lineEnd >= 0) {
        this.state = 'open';
        if (isPlanLine(opening.slice(0, lineEnd)))
          this.blank(index + 1, opening.slice(lineEnd).trimStart());
        return this.release(this.held.length);
      }
      if (opening.length > OPENING_MAX_CHARACTERS) {
        this.state = 'open';
        return this.release(this.held.length);
      }
    }
    return Promise.resolve();
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
    const recorded = this.chain.then(() => this.pass(event));
    this.chain = recorded.catch(() => undefined);
    return recorded;
  }
}
