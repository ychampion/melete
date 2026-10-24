/**
 * The agent's words, as a person would write them, on their way into the record.
 *
 * Every runtime event of an attempt passes through here before it is recorded.
 * Text deltas go through the plain-text pass (`humanText` in the contracts
 * package), so what the person sees as it streams is what the saved answer
 * says. Nothing else is changed, and no event is added, dropped or reordered:
 *
 * - A delta carries what can be shown so far. A dash, or a closing line, whose
 *   reading depends on words still to come is held back and goes out with a
 *   later delta, so a delta's text can be shorter, longer or empty.
 * - The latest delta is held, with the events behind it, only while the pass is
 *   holding words, so the end of the message can still reach the record in
 *   it. When the pass holds nothing, every event goes straight through.
 * - A message ends at a step, a result, a request, a new model turn or the
 *   outcome. Its held words are settled into the delta held for it, then
 *   that delta and the event go out in order.
 * - The outcome's own text (its summary, question or draft) gets the same pass.
 *
 * Each event is recorded after the one before it. A delta is acknowledged at
 * once, before it is recorded, so the runtime is never kept waiting on words
 * held for the next one; a failure to record it surfaces on the next event.
 */
import { type AttemptOutcome, HumanText, humanText, type RuntimeEvent } from '@melete/contracts';

/** An outcome's text after the pass: what the person reads when the attempt ends. */
export function humanOutcome(outcome: AttemptOutcome): AttemptOutcome {
  switch (outcome.kind) {
    case 'completed':
    case 'budget_exhausted': {
      const summary = humanText(outcome.summary);
      return summary === outcome.summary ? outcome : { ...outcome, summary };
    }
    case 'waiting_for_input': {
      const question = humanText(outcome.question);
      const draft = outcome.draft === undefined ? undefined : humanText(outcome.draft);
      return question === outcome.question && draft === outcome.draft
        ? outcome
        : { ...outcome, question, ...(draft === undefined ? {} : { draft }) };
    }
    default:
      return outcome;
  }
}

/**
 * Events that can arrive in the middle of a message without ending it: the
 * model's reasoning, an observation about the run, a note that the engine went
 * quiet or that the person's words reached it.
 */
const ASIDES: ReadonlySet<RuntimeEvent['type']> = new Set([
  'reasoning_delta',
  'hook_event',
  'hook_error',
  'stalled',
  'steer_delivered',
  'gap',
]);

export class HumanStream {
  private text = new HumanText('reply');
  /** The latest delta, waiting for the words the pass still holds. */
  private held: Extract<RuntimeEvent, { type: 'text_delta' }> | null = null;
  /** Events that arrived after the held delta, in order. */
  private behind: RuntimeEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  /** `pass` records one event; it is called in order, one at a time. */
  constructor(private readonly pass: (event: RuntimeEvent) => Promise<void>) {}

  emit(event: RuntimeEvent): Promise<void> {
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      return Promise.reject(failure);
    }
    if (event.type === 'text_delta') {
      const shown = this.text.push(event.text);
      const previous = this.release();
      const delta = { ...event, text: shown };
      if (this.text.idle) return Promise.all([previous, this.record(delta)]).then(() => undefined);
      this.held = delta;
      // Acknowledged now: the words it waits on come with the next delta.
      void previous.catch((error: unknown) => {
        this.failure ??= error;
      });
      return Promise.resolve();
    }
    if (ASIDES.has(event.type)) {
      // An aside written mid-message waits behind the delta, in order. With
      // no delta held it goes straight through, and the message goes on: the
      // words after it are read with the words before.
      if (!this.held) return this.record(event);
      this.behind.push(event);
      return Promise.resolve();
    }
    // Anything else ends the message: its last words go out first.
    const ended = this.end();
    const out =
      event.type === 'attempt_outcome' ? { ...event, outcome: humanOutcome(event.outcome) } : event;
    return Promise.all([ended, this.record(out)]).then(() => undefined);
  }

  /**
   * The attempt is ending without another event: what is held is settled and
   * recorded. Resolves once every event handed in has been recorded or failed.
   */
  async drain(): Promise<void> {
    const ended = this.end();
    await Promise.allSettled([ended, this.chain]);
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
  }

  /** Settles the current message: the pass's last words go into the held delta. */
  private end(): Promise<void> {
    const rest = this.text.end();
    this.text = new HumanText('reply');
    if (this.held) this.held = { ...this.held, text: this.held.text + rest };
    // Words with no delta left to carry them can only come from a delta that
    // went straight through; the pass held nothing then, so there are none.
    return this.release();
  }

  /** Records the held delta and the events behind it, in order. */
  private release(): Promise<void> {
    const out = [...(this.held ? [this.held] : []), ...this.behind];
    this.held = null;
    this.behind = [];
    return Promise.all(out.map((event) => this.record(event))).then(() => undefined);
  }

  private record(event: RuntimeEvent): Promise<void> {
    const recorded = this.chain.then(() => this.pass(event));
    this.chain = recorded.catch(() => undefined);
    return recorded;
  }
}
