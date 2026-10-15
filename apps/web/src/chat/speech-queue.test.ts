import { describe, expect, test } from 'bun:test';
import {
  BUSY,
  BUSY_RETRY_MS,
  createSpeechQueue,
  SPEECH_AHEAD,
  type SpeechAnswer,
  type SpeechQueueOptions,
  STILL_BUSY,
} from './speech-queue.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A fake speech service. Each request waits until the test answers it, so the
 * test sees how many are open at once and can answer them in any order.
 */
function harness(overrides: Partial<SpeechQueueOptions> = {}) {
  const open: { text: string; signal: AbortSignal; answer: (a: SpeechAnswer) => void }[] = [];
  const asked: string[] = [];
  const played: string[] = [];
  const problems: string[] = [];
  const waits: number[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let idle = 0;
  const queue = createSpeechQueue({
    fetch: (text, signal) => {
      asked.push(text);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise<SpeechAnswer>((resolve, reject) => {
        const request = {
          text,
          signal,
          answer: (answer: SpeechAnswer) => {
            inFlight -= 1;
            resolve(answer);
          },
        };
        signal.addEventListener('abort', () => {
          inFlight -= 1;
          open.splice(open.indexOf(request), 1);
          reject(new DOMException('aborted', 'AbortError'));
        });
        open.push(request);
      });
    },
    play: async (audio) => {
      played.push(await audio.text());
    },
    onProblem: (message) => problems.push(message),
    onIdle: () => {
      idle += 1;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });

  /** Answer the open request for this piece. */
  const answer = async (text: string, result?: SpeechAnswer) => {
    await settle();
    const index = open.findIndex((request) => request.text === text);
    if (index < 0) throw new Error(`no open request for ${text}`);
    const [request] = open.splice(index, 1);
    request?.answer(result ?? { data: new Blob([text]) });
    await settle();
  };

  return {
    queue,
    answer,
    asked,
    played,
    problems,
    waits,
    get open() {
      return open.map((request) => request.text);
    },
    get mostInFlight() {
      return mostInFlight;
    },
    get idle() {
      return idle;
    },
  };
}

const failed = (error = 'The speech service could not read that aloud just now.') => ({
  data: null,
  error,
  code: 'voice_provider_failed',
});
const busy = () => ({
  data: null,
  error: 'The speech service is busy just now. Try again in a moment.',
  code: BUSY,
});

describe('reading a reply aloud', () => {
  test('a long reply asks for at most two pieces at once and plays them all in order', async () => {
    const run = harness();
    const pieces = Array.from({ length: 12 }, (_, i) => `piece ${i + 1}`);
    for (const piece of pieces) run.queue.push(piece);
    await settle();
    expect(run.open).toEqual(['piece 1', 'piece 2']);
    for (const piece of pieces) await run.answer(piece);
    expect(run.mostInFlight).toBe(SPEECH_AHEAD);
    expect(run.played).toEqual(pieces);
    expect(run.problems).toEqual([]);
    expect(run.idle).toBe(1);
    expect(run.queue.busy).toBe(false);
  });

  test('a later piece that arrives first still waits for its turn', async () => {
    const run = harness();
    for (const piece of ['one', 'two', 'three']) run.queue.push(piece);
    await run.answer('two');
    expect(run.played).toEqual([]);
    await run.answer('one');
    await run.answer('three');
    expect(run.played).toEqual(['one', 'two', 'three']);
  });

  test('a piece that fails is skipped and the rest of the reply still plays', async () => {
    const run = harness();
    for (const piece of ['one', 'two', 'three', 'four']) run.queue.push(piece);
    await run.answer('one');
    await run.answer('two', failed());
    await run.answer('three');
    await run.answer('four');
    expect(run.played).toEqual(['one', 'three', 'four']);
    expect(run.problems).toEqual(['The speech service could not read that aloud just now.']);
    expect(run.idle).toBe(1);
    expect(run.queue.busy).toBe(false);
  });

  test('a failure on the very first piece does not stop the rest', async () => {
    const run = harness();
    for (const piece of ['one', 'two']) run.queue.push(piece);
    await run.answer('one', failed());
    await run.answer('two');
    expect(run.played).toEqual(['two']);
  });

  test('a busy service is asked once more after a wait, and the piece plays', async () => {
    const run = harness();
    for (const piece of ['one', 'two', 'three']) run.queue.push(piece);
    await run.answer('one', busy());
    expect(run.waits).toEqual([BUSY_RETRY_MS]);
    await run.answer('one');
    await run.answer('two');
    await run.answer('three');
    expect(run.asked).toEqual(['one', 'two', 'one', 'three']);
    expect(run.played).toEqual(['one', 'two', 'three']);
    expect(run.problems).toEqual([]);
    expect(run.mostInFlight).toBeLessThanOrEqual(SPEECH_AHEAD);
  });

  test('a piece still busy on the second ask is skipped, and the rest plays', async () => {
    const run = harness();
    for (const piece of ['one', 'two']) run.queue.push(piece);
    await run.answer('one', busy());
    await run.answer('one', busy());
    await run.answer('two');
    expect(run.waits).toEqual([BUSY_RETRY_MS]);
    expect(run.played).toEqual(['two']);
    expect(run.problems).toEqual([STILL_BUSY]);
  });

  test('stopping drops what is queued and cancels the open requests; new pieces play after', async () => {
    const run = harness();
    for (const piece of ['one', 'two', 'three']) run.queue.push(piece);
    await settle();
    run.queue.clear();
    await settle();
    expect(run.open).toEqual([]);
    expect(run.queue.busy).toBe(false);
    expect(run.problems).toEqual([]);
    run.queue.push('after');
    await run.answer('after');
    expect(run.played).toEqual(['after']);
    expect(run.asked).toEqual(['one', 'two', 'after']);
  });

  test('stopping mid-playback ends that piece and plays nothing more of the old reply', async () => {
    const played: string[] = [];
    let release: (() => void) | null = null;
    const run = harness({
      play: async (audio, signal) => {
        played.push(await audio.text());
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve());
        });
      },
    });
    for (const piece of ['one', 'two']) run.queue.push(piece);
    await run.answer('one');
    await run.answer('two');
    expect(played).toEqual(['one']);
    run.queue.clear();
    await settle();
    (release as (() => void) | null)?.();
    await settle();
    expect(played).toEqual(['one']);
    expect(run.queue.busy).toBe(false);
  });
});
