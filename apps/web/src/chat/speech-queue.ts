/**
 * The pieces of a reply read aloud, in order.
 *
 * Each piece is fetched as speech a little ahead of when it plays: the one
 * about to play and the next, never more at once, so a long reply does not
 * send a burst of requests the speech service turns away. A piece the service
 * was too busy for is asked for once more after a short wait. A piece that
 * still fails is skipped and the rest of the reply goes on.
 */

/** How many pieces are fetched at the same time, at most. */
export const SPEECH_AHEAD = 2;
/** The wait before asking again for a piece the service was too busy for. */
export const BUSY_RETRY_MS = 1500;
/** The service's code for a piece turned away because it had too many at once. */
export const BUSY = 'voice_busy';

const FAILED = 'The reply could not be read aloud.';
/** Shown when a piece was still turned away after the second ask, and skipped. */
export const STILL_BUSY = 'The speech service was busy, so part of the reply was skipped.';

export type SpeechAnswer = {
  data: Blob | null;
  error?: string | null;
  code?: string;
};

export type SpeechQueueOptions = {
  /** Ask for one piece as speech. */
  fetch: (text: string, signal: AbortSignal) => Promise<SpeechAnswer>;
  /** Play one piece; resolves when it has finished, failed, or the signal aborts. */
  play: (audio: Blob, signal: AbortSignal) => Promise<void>;
  /** A piece has started playing. */
  onSpeaking?: () => void;
  /** The last queued piece has been played or skipped. */
  onIdle?: () => void;
  /** A piece could not be read aloud; the message is fit to show. */
  onProblem?: (message: string) => void;
  /** Wait before a retry; resolves early when the signal aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type SpeechQueue = {
  /** Read this piece aloud after the ones already queued. */
  push: (text: string) => void;
  /** Stop: drop every queued piece, cancel the fetches, stop playing. */
  clear: () => void;
  /** Whether something is playing or waiting to play. */
  readonly busy: boolean;
};

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

type Piece = { text: string; audio: Promise<Blob | null> | null };

export function createSpeechQueue(options: SpeechQueueOptions): SpeechQueue {
  const wait = options.wait ?? pause;
  let pending: Piece[] = [];
  let running = false;
  let control = new AbortController();

  async function load(text: string, signal: AbortSignal): Promise<Blob | null> {
    for (let attempt = 0; ; attempt += 1) {
      let answer: SpeechAnswer;
      try {
        answer = await options.fetch(text, signal);
      } catch {
        // Aborted, or no answer at all: nothing to play for this piece.
        if (!signal.aborted) options.onProblem?.(FAILED);
        return null;
      }
      if (signal.aborted) return null;
      if (answer.data) return answer.data;
      if (answer.code === BUSY) {
        if (attempt === 0) {
          await wait(BUSY_RETRY_MS, signal);
          if (signal.aborted) return null;
          continue;
        }
        // The service's own words ask the person to try again; here nothing is left to try.
        options.onProblem?.(STILL_BUSY);
        return null;
      }
      options.onProblem?.(answer.error ?? FAILED);
      return null;
    }
  }

  /** Start fetching the pieces at the front that have not been asked for yet. */
  function fill(signal: AbortSignal) {
    for (const piece of pending.slice(0, SPEECH_AHEAD))
      if (!piece.audio) piece.audio = load(piece.text, signal);
  }

  async function run() {
    if (running) return;
    running = true;
    const signal = control.signal;
    while (pending.length > 0) {
      fill(signal);
      const audio = await pending[0]?.audio;
      if (signal.aborted) return;
      pending.shift();
      fill(signal);
      // A piece that could not be fetched is skipped; the rest still plays.
      if (!audio) continue;
      options.onSpeaking?.();
      await options.play(audio, signal).catch(() => undefined);
      if (signal.aborted) return;
    }
    running = false;
    options.onIdle?.();
  }

  return {
    push(text) {
      pending.push({ text, audio: null });
      fill(control.signal);
      void run();
    },
    clear() {
      control.abort();
      control = new AbortController();
      pending = [];
      running = false;
    },
    get busy() {
      return running || pending.length > 0;
    },
  };
}
