/**
 * One call, as the service holds it: the upstream WebSocket ElevenLabs opened,
 * and the conversation it speaks into.
 *
 * Each time the person finishes a turn, ElevenLabs sends what was said. It
 * goes into the chat exactly as a typed message does, so the agent answers
 * with its tools, memory and approvals, and the turn's tool rows show in the
 * chat as they happen. The answer is read aloud as it is written, a sentence at
 * a time. While the agent works and has nothing to say yet, the call says so
 * briefly, and again now and then, so it never goes silent.
 *
 * Talking over the agent is handled by ElevenLabs: speech stops at once, and a
 * new transcript arrives with a higher event id. Whatever this side was still
 * sending for the old one is dropped. The work itself is not stopped by being
 * talked over: what was said goes to the running turn, or to the light
 * companion for a quick answer, and "stop", "pause" or "carry on" work the
 * controls, as in voice mode.
 *
 * A decision is never made by voice. When the work waits on an approval or a
 * question, the call says so out loud and the card is in the chat.
 *
 * Hanging up ends the call and nothing else: a job the call started keeps
 * running, and its answer lands in the chat.
 */
import {
  asksToStop,
  nextPiece,
  type QuickCommand,
  quickCommand,
  speakable,
} from '@melete/contracts';
import { type UpstreamReply, upstreamMessage } from '../connectors/speech-engine.ts';
import { answerStream, answerText } from '../experience/answer-filter.ts';

/** Where a turn is, as the chat records it. */
export type CallTurn = { status: string; answer: string };

/** What waits on the person in the conversation, said out loud and shown as a card. */
export type CallWaiting =
  | { kind: 'approval'; key: string }
  | { kind: 'question'; key: string; text: string };

/** What the companion made of something said while the work runs. */
export type CallAside = { intent: 'talk' | 'steer' | 'stop' | 'quiet'; say: string | null };

/** The conversation a call speaks into. Every method acts as the person on the call. */
export type CallChat = {
  /**
   * Say this in the chat as the person: a new turn, or words passed to the turn
   * already running. The turn is the one now under way; `refused` is why the
   * chat did not take it, in words to say.
   */
  say(text: string): Promise<{ turnId: string } | { refused: string }>;
  /** The turn now under way, or null when none is. A turn waiting on the person is not under way. */
  running(): Promise<string | null>;
  turn(turnId: string): Promise<CallTurn | null>;
  waiting(): Promise<CallWaiting | null>;
  control(command: QuickCommand): Promise<void>;
  /** The companion, for a quick word while the work runs. Left out, what is said goes to the work. */
  aside?: (text: string) => Promise<CallAside | null>;
};

export type CallLink = { send(reply: UpstreamReply): void; close(): void };

export type CallTiming = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How often the turn is read while the agent works. */
  pollMs: number;
  /** Silence before the first word that says the agent is working. */
  fillerMs: number;
  /** Silence after which the call says, again, that it is still working. */
  stillMs: number;
  /**
   * How long one answer is waited for before the call says the work goes on
   * and hands back the floor. The work is not stopped.
   */
  holdMs: number;
  /** Silence, while a decision or a question waits on the screen, after which the call says it still waits. */
  waitMs: number;
  /**
   * How many times the call says it still waits on one decision or question.
   * After that it says the decision stays on the screen and hands back the
   * floor, so a long wait neither repeats itself nor goes quiet mid-answer.
   */
  waitReminders: number;
};

const DEFAULT_TIMING: CallTiming = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs: 200,
  fillerMs: 1200,
  // ElevenLabs asks again when a response goes quiet for its cascade timeout
  // (15 s here), and drops the call after asking a few times: every quiet
  // stretch inside a response stays well under it.
  stillMs: 10_000,
  holdMs: 120_000,
  waitMs: 12_000,
  // With the first mention, about 45 seconds of waiting on the call.
  waitReminders: 3,
};

/** What the call says, kept short: it is heard, not read. */
export const CALL_WORDS = {
  filler: 'Looking that up.',
  still: ['Still working on it.', 'Still on it.', 'Bear with me, I’m still working on it.'],
  long: 'This is taking a while. I’ll keep working on it, and the answer will be in the chat.',
  failed: 'I couldn’t finish that. What happened is in the chat.',
  approval: 'Before I go ahead, I need your OK. I’ve put it on your screen.',
  question: 'I need to ask you something. It’s on your screen:',
  approvalStill: [
    'I’m still waiting for your OK on the screen.',
    'Still waiting for your OK.',
    'Your OK is still on the screen when you’re ready.',
  ],
  questionStill: [
    'I’m still waiting for your answer on the screen.',
    'Still waiting for your answer.',
    'The question is still on the screen when you’re ready.',
  ],
  approvalLeft: 'I’ll leave it on your screen. Once you’ve decided, the rest will be in the chat.',
  questionLeft:
    'I’ll leave the question on your screen. Once you’ve answered, the rest will be in the chat.',
  stillOnScreen: 'That’s still waiting for you on the screen.',
  passedOn: 'Got it. I’ve passed that on.',
  stopping: 'Stopping now.',
  paused: 'Paused. Say carry on when you’re ready.',
  resumed: 'Carrying on.',
} as const;

const UNDER_WAY = new Set(['queued', 'working', 'streaming', 'stalled', 'paused']);
const WRITING = new Set(['queued', 'working', 'streaming', 'stalled']);

/** The person's latest words in the history ElevenLabs sends, or nothing when the last turn is not theirs. */
function latestSaid(history: Array<{ role: string; content: string }>): string {
  const last = history.at(-1);
  const words = last?.role === 'user' ? last.content.trim() : '';
  // A transcript of a noise ("...") has no words in it, and is not a message.
  return /[\p{L}\p{N}]/u.test(words) ? words : '';
}

export class CallSession {
  private readonly timing: CallTiming;
  private chat: CallChat | null = null;
  private binding: Promise<CallChat | null> | null = null;
  private closed = false;
  /** The response being sent now, and the transcript event it answers. */
  private current: { eventId: number | undefined; abort: AbortController } | null = null;
  /** How much of each turn's spoken answer has been sent, so a turn is never read twice. */
  private readonly spoken = new Map<string, number>();
  /**
   * Each wait the call has told, and how many times it has said, since, that
   * it still waits: one approval is announced once and reminded of a few times.
   */
  private readonly told = new Map<string, number>();
  /** The waits the call has said it leaves on the screen; they are not reminded of again. */
  private readonly leftOnScreen = new Set<string>();
  /** The newest transcript event, and how many of the person's turns have been taken. */
  private latestEvent: number | undefined;
  private heard = 0;
  /** The turn the call is reading, and the turns it already said it was working on. */
  private following: string | null = null;
  private readonly filled = new Set<string>();
  private stillLine = 0;

  constructor(
    private readonly link: CallLink,
    /** The conversation the provider's call id was started for, or null when it was not. */
    private readonly bind: (conversationId: string) => Promise<CallChat | null>,
    timing: Partial<CallTiming> = {},
    private readonly hooks: { onBound?: () => void; onEnded?: () => void } = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  /** One message from the upstream WebSocket. */
  async receive(raw: string): Promise<void> {
    if (this.closed) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = upstreamMessage.safeParse(json);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'ping') return this.link.send({ type: 'pong' });
    if (message.type === 'close' || message.type === 'error') return this.end(true);
    if (message.type === 'init') {
      if (this.binding) return;
      this.binding = this.bind(message.conversation_id).catch((error: unknown) => {
        process.stderr.write(
          `call: a call could not be joined to its chat (${error instanceof Error ? error.message : 'error'})\n`,
        );
        return null;
      });
      const chat = await this.binding;
      if (!chat) return this.end(true);
      this.chat = chat;
      this.hooks.onBound?.();
      return;
    }
    // Words before the call was bound to a conversation have nowhere to go.
    const chat = this.binding ? await this.binding : null;
    if (!chat || this.closed) return;
    // ElevenLabs asks again for an event it got no answer to in time. One older
    // than the event being answered is already superseded, and is dropped there.
    const eventId = message.event_id;
    if (eventId !== undefined && this.latestEvent !== undefined && eventId < this.latestEvent)
      return;
    if (eventId !== undefined) this.latestEvent = eventId;
    const abort = new AbortController();
    // A newer transcript is the person talking over the answer: this side stops
    // sending the old one, which ElevenLabs has already stopped speaking.
    this.current?.abort.abort();
    this.current = { eventId, abort };
    const history = message.user_transcript;
    const users = history.filter((entry) => entry.role === 'user').length;
    const newWords = users > this.heard && history.at(-1)?.role === 'user';
    if (newWords) this.heard = users;
    // The same words again (a corrected transcript, or the event asked for once
    // more) are not a new message: the answer under way carries on under this event.
    const work = newWords
      ? this.answer(chat, latestSaid(history), eventId, abort.signal)
      : this.carryOn(chat, eventId, abort.signal, history.at(-1)?.role === 'agent');
    await work
      .catch((error: unknown) => {
        process.stderr.write(
          `call: an answer failed (${error instanceof Error ? error.name : 'error'})\n`,
        );
        if (!abort.signal.aborted) this.speak(eventId, CALL_WORDS.failed, true);
      })
      .finally(() => {
        if (this.current?.abort === abort) this.current = null;
      });
  }

  /** The upstream WebSocket closed: the call is over. The work is left running. */
  closedByPeer(): void {
    this.end(false);
  }

  get bound(): boolean {
    return this.chat !== null;
  }

  private end(closeLink: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.current?.abort.abort();
    this.current = null;
    if (closeLink) this.link.close();
    this.hooks.onEnded?.();
  }

  private speak(eventId: number | undefined, content: string, final: boolean) {
    if (this.closed) return;
    if (content)
      // Pieces are joined as they are spoken, so each ends with a space.
      this.link.send({
        type: 'agent_response',
        content: `${content} `,
        event_id: eventId,
        is_final: false,
      });
    if (final)
      this.link.send({ type: 'agent_response', content: '', event_id: eventId, is_final: true });
  }

  private async answer(
    chat: CallChat,
    said: string,
    eventId: number | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    // Nothing new from the person, as when the provider re-engages a quiet line.
    if (!said) return this.speak(eventId, '', true);
    const running = await chat.running();
    if (signal.aborted) return;
    if (running) {
      const command = quickCommand(said);
      if (command) {
        await chat.control(command);
        if (signal.aborted) return;
        if (command === 'stop') return this.speak(eventId, CALL_WORDS.stopping, true);
        this.speak(eventId, command === 'pause' ? CALL_WORDS.paused : CALL_WORDS.resumed, false);
        return this.follow(chat, running, eventId, signal, true);
      }
      const aside = chat.aside ? await chat.aside(said).catch(() => null) : null;
      if (signal.aborted) return;
      if (aside?.intent === 'talk' && aside.say) {
        this.speak(eventId, aside.say, false);
        return this.follow(chat, running, eventId, signal, true);
      }
      if (aside?.intent === 'stop' && asksToStop(said)) {
        await chat.control('stop');
        if (signal.aborted) return;
        return this.speak(eventId, CALL_WORDS.stopping, true);
      }
      if (aside?.intent === 'quiet') return this.follow(chat, running, eventId, signal, true);
      // Anything else is for the work: the running turn takes it as it goes.
    }
    const taken = await chat.say(said);
    if (signal.aborted) return;
    if ('refused' in taken) return this.speak(eventId, taken.refused, true);
    if (running && taken.turnId === running) this.speak(eventId, CALL_WORDS.passedOn, false);
    return this.follow(chat, taken.turnId, eventId, signal, running !== null);
  }

  /** The same words again: carry on reading the turn under way, or end the response when there is none. */
  private async carryOn(
    chat: CallChat,
    eventId: number | undefined,
    signal: AbortSignal,
    /** The provider heard this side's words before asking again, so they are not repeated. */
    heardBefore: boolean,
  ) {
    const turnId = this.following ?? (await chat.running());
    if (signal.aborted) return;
    if (!turnId) return this.speak(eventId, '', true);
    return this.follow(chat, turnId, eventId, signal, false, heardBefore);
  }

  /**
   * Read the turn's answer aloud as it is written, and say the agent is
   * working while it has nothing to say. Ends the response when the turn ends,
   * waits on the person, or has run past the hold.
   */
  private async follow(
    chat: CallChat,
    turnId: string,
    eventId: number | undefined,
    signal: AbortSignal,
    alreadySpoke: boolean,
    heardBefore = false,
  ): Promise<void> {
    const { now, sleep, pollMs, fillerMs, stillMs, holdMs, waitMs, waitReminders } = this.timing;
    this.following = turnId;
    /** Whether this response has said anything about what waits on the screen. */
    let mentioned = false;
    let heldFrom = now();
    // A turn the call already said it was working on is not announced again: a
    // response that carries it on says it is still working, soon.
    const carried = !alreadySpoke && heardBefore && this.filled.has(turnId);
    let lastWord = alreadySpoke ? now() : carried ? now() - stillMs + fillerMs : null;
    let filled = alreadySpoke || carried;
    if (filled) this.filled.add(turnId);
    for (;;) {
      if (signal.aborted || this.closed) return;
      const turn = await chat.turn(turnId);
      if (signal.aborted || this.closed) return;
      if (!turn) return this.speak(eventId, '', true);
      const writing = WRITING.has(turn.status);
      const text = speakable(writing ? answerStream(turn.answer) : answerText(turn.answer));
      const done = !UNDER_WAY.has(turn.status);
      for (
        let piece = nextPiece(text, this.spoken.get(turnId) ?? 0, done);
        piece;
        piece = nextPiece(text, this.spoken.get(turnId) ?? 0, done)
      ) {
        this.spoken.set(turnId, piece.end);
        this.speak(eventId, piece.piece, false);
        lastWord = now();
        filled = true;
      }
      const waiting = await chat.waiting();
      if (signal.aborted || this.closed) return;
      if (waiting) {
        const at = now();
        const approval = waiting.kind === 'approval';
        const reminders = this.told.get(waiting.key);
        if (this.leftOnScreen.has(waiting.key)) {
          // Already handed back: a new response says where it is, once, and ends.
          if (!mentioned) return this.speak(eventId, CALL_WORDS.stillOnScreen, true);
        } else if (reminders === undefined) {
          this.told.set(waiting.key, 0);
          this.speak(
            eventId,
            approval ? CALL_WORDS.approval : `${CALL_WORDS.question} ${waiting.text.slice(0, 300)}`,
            false,
          );
          mentioned = true;
          lastWord = at;
          filled = true;
          // The person decides on the screen; the answer that follows is still read.
          heldFrom = at;
        } else if (!mentioned || at - (lastWord ?? heldFrom) >= waitMs) {
          // Quiet for too long inside a response, the provider asks again and
          // in the end drops the call: say it still waits, a few times, then
          // leave the decision on the screen and hand back the floor.
          if (reminders >= waitReminders) {
            this.leftOnScreen.add(waiting.key);
            return this.speak(
              eventId,
              approval ? CALL_WORDS.approvalLeft : CALL_WORDS.questionLeft,
              true,
            );
          }
          const lines = approval ? CALL_WORDS.approvalStill : CALL_WORDS.questionStill;
          this.speak(eventId, lines[reminders % lines.length] ?? lines[0], false);
          this.told.set(waiting.key, reminders + 1);
          mentioned = true;
          lastWord = at;
          filled = true;
        }
      }
      if (done) {
        if (turn.status === 'failed' && !this.spoken.get(turnId))
          return this.speak(eventId, CALL_WORDS.failed, true);
        if (turn.status === 'needs_you' && !waiting && !this.spoken.get(turnId))
          return this.speak(eventId, CALL_WORDS.approval, true);
        return this.speak(eventId, '', true);
      }
      const at = now();
      if (at - heldFrom >= holdMs) return this.speak(eventId, CALL_WORDS.long, true);
      if (!filled && at - heldFrom >= fillerMs) {
        this.speak(eventId, CALL_WORDS.filler, false);
        filled = true;
        this.filled.add(turnId);
        lastWord = at;
      } else if (lastWord !== null && at - lastWord >= stillMs && !waiting) {
        const lines = CALL_WORDS.still;
        this.speak(eventId, lines[this.stillLine++ % lines.length] ?? lines[0], false);
        lastWord = at;
      }
      await sleep(pollMs);
    }
  }
}
