import { describe, expect, test } from 'bun:test';
import { type AttemptOutcome, humanText, type RuntimeEvent } from '@melete/contracts';
import { HumanStream, humanOutcome } from './human-stream.ts';

const ATTEMPT = 'att_01J8ZP3QWABCDEFGHJKMNPQRST' as RuntimeEvent['attempt_id'];
let seq = 0;
const base = () => {
  seq++;
  return {
    attempt_id: ATTEMPT,
    local_seq: seq,
    dedup_key: `k${seq}`,
    at: '2026-10-01T00:00:00.000Z',
  };
};
const delta = (text: string): RuntimeEvent => ({ ...base(), type: 'text_delta', text });
const reasoning = (text: string): RuntimeEvent => ({ ...base(), type: 'reasoning_delta', text });
const step = (): RuntimeEvent => ({
  ...base(),
  type: 'tool_call_proposed',
  tool: 'web.search',
  call_id: 'c1',
  arguments: {},
});
const done = (summary: string): RuntimeEvent => ({
  ...base(),
  type: 'attempt_outcome',
  outcome: { kind: 'completed', summary } as AttemptOutcome,
});

function recorder() {
  const recorded: RuntimeEvent[] = [];
  const stream = new HumanStream(async (event) => {
    await Promise.resolve();
    recorded.push(event);
  });
  const shown = () =>
    recorded
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event as { text: string }).text)
      .join('');
  return { stream, recorded, shown };
}

const REPLY = 'The office opens at nine — bring the form. Hours are 9–5, Monday to Friday.';

describe('the stream on its way to the record', () => {
  test('records what the whole-text pass gives, however the reply is split', async () => {
    for (const size of [1, 2, 5, 13, REPLY.length]) {
      const { stream, shown } = recorder();
      for (let at = 0; at < REPLY.length; at += size)
        await stream.emit(delta(REPLY.slice(at, at + size)));
      await stream.drain();
      expect(shown()).toBe(humanText(REPLY));
    }
  });

  test('keeps every event, in order, and adds none', async () => {
    const { stream, recorded } = recorder();
    const sent = [
      delta('Checking now —'),
      reasoning('think'),
      delta(' then I write.'),
      step(),
      done('Done.'),
    ];
    for (const event of sent) await stream.emit(event);
    await stream.drain();
    expect(recorded.map((event) => event.local_seq)).toEqual(sent.map((event) => event.local_seq));
    expect(recorded.map((event) => event.type)).toEqual(sent.map((event) => event.type));
  });

  test('a dash held at a step is settled into the message before the step', async () => {
    const { stream, recorded } = recorder();
    await stream.emit(delta('Looking it up —'));
    await stream.emit(step());
    await stream.drain();
    expect(recorded[0]?.type).toBe('text_delta');
    expect((recorded[0] as { text: string }).text).toBe(humanText('Looking it up —'));
    expect((recorded[0] as { text: string }).text).not.toContain('—');
    expect(recorded[1]?.type).toBe('tool_call_proposed');
  });

  test('a split dash reads the same as a whole one', async () => {
    const { stream, shown } = recorder();
    await stream.emit(delta('It is set '));
    await stream.emit(delta('—'));
    await stream.emit(delta(' the room is booked.'));
    await stream.drain();
    expect(shown()).toBe(humanText('It is set — the room is booked.'));
  });

  test('the outcome is voiced as it is recorded', async () => {
    const { stream, recorded } = recorder();
    await stream.emit(done('Certainly! The form is in — page two.'));
    await stream.drain();
    const outcome = (recorded[0] as { outcome: AttemptOutcome }).outcome;
    expect(outcome).toEqual({
      kind: 'completed',
      summary: humanText('Certainly! The form is in — page two.'),
    } as AttemptOutcome);
    expect(JSON.stringify(outcome)).not.toContain('—');
  });

  test('a failure to record surfaces, on the next event or at drain', async () => {
    const stream = new HumanStream(async () => {
      throw new Error('store down');
    });
    await expect(stream.emit(step())).rejects.toThrow('store down');
    await stream.emit(delta('Half a thought —'));
    await stream.emit(delta(' and the rest'));
    await expect(stream.drain()).rejects.toThrow('store down');
  });
});

describe('an outcome after the pass', () => {
  test('voices a summary, a question and a draft, and leaves other outcomes alone', () => {
    const question = humanOutcome({
      kind: 'waiting_for_input',
      question: 'Which day works — Monday or Tuesday?',
      draft: 'Hi Sam — the lease is attached.',
    } as AttemptOutcome) as { question: string; draft: string };
    expect(question.question).not.toContain('—');
    expect(question.draft).not.toContain('—');
    const failed = {
      kind: 'failed',
      error: { code: 'x', message: 'a — b' },
    } as unknown as AttemptOutcome;
    expect(humanOutcome(failed)).toBe(failed);
    const plain = { kind: 'completed', summary: 'All set.' } as AttemptOutcome;
    expect(humanOutcome(plain)).toBe(plain);
  });
});

/** Records events in batches, each batch after a short write, like one transaction. */
function together(fail?: (event: RuntimeEvent) => unknown) {
  const recorded: RuntimeEvent[] = [];
  const batches: number[] = [];
  const stream = new HumanStream(
    async (event) => {
      await Bun.sleep(1);
      const error = fail?.(event);
      if (error) throw error;
      recorded.push(event);
    },
    async (events) => {
      batches.push(events.length);
      await Bun.sleep(1);
      return events.map((event) => {
        const error = fail?.(event);
        if (error) return { error };
        recorded.push(event);
        return null;
      });
    },
  );
  return { stream, recorded, batches };
}

/** A seeded run of events a reply might send. */
function randomRun(seed: number): RuntimeEvent[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const words = ['It is ', 'set — ', 'the room ', 'is booked.', ' Hours: 9–5', '…', ' ok'];
  const run: RuntimeEvent[] = [];
  const length = 5 + Math.floor(next() * 120);
  for (let index = 0; index < length; index++) {
    const pick = next();
    if (pick < 0.7) run.push(delta(words[Math.floor(next() * words.length)] ?? ''));
    else if (pick < 0.85) run.push(reasoning('think'));
    else run.push(step());
  }
  run.push(done('Done — all set.'));
  return run;
}

describe('the stream recorded together', () => {
  test('records the same events, in the same order, as one at a time', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const run = randomRun(seed);
      const alone = recorder();
      for (const event of run) await alone.stream.emit(event);
      await alone.stream.drain();
      // The runtime hands events in as they come, waiting only where the stream says to.
      const batched = together();
      const waits: Promise<void>[] = [];
      for (const [index, event] of run.entries()) {
        const emitted = batched.stream.emit(event);
        if (index % 7 === 0) await emitted;
        else waits.push(emitted);
      }
      await Promise.all(waits);
      await batched.stream.drain();
      const view = (events: RuntimeEvent[]) =>
        events.map((event) => [event.local_seq, event.type, (event as { text?: string }).text]);
      expect(view(batched.recorded)).toEqual(view(alone.recorded));
    }
  });

  test('words that arrive while a write is under way go in a few writes, not one each', async () => {
    const { stream, recorded, batches } = together();
    await stream.emit(step());
    for (let index = 0; index < 200; index++) await stream.emit(delta(`piece ${index}. `));
    await stream.emit(done('Done.'));
    await stream.drain();
    expect(recorded).toHaveLength(202);
    expect(batches.length).toBeLessThan(20);
    expect(Math.max(...batches)).toBeLessThanOrEqual(64);
  });

  test('a failed event fails alone, and a failed word surfaces on the next event or at drain', async () => {
    const refused = (event: RuntimeEvent) =>
      event.type === 'tool_call_proposed' || (event as { text?: string }).text?.includes('bad')
        ? new Error('refused')
        : undefined;
    const { stream, recorded } = together(refused);
    const before = stream.emit(delta('First. '));
    await expect(stream.emit(step())).rejects.toThrow('refused');
    await before;
    expect(recorded.map((event) => event.type)).toEqual(['text_delta']);
    await stream.emit(delta('bad words. '));
    await stream.emit(delta('more. '));
    await expect(stream.drain()).rejects.toThrow('refused');
    // The words after the failed ones were still recorded, as one at a time would.
    expect(recorded.map((event) => (event as { text?: string }).text).join('')).toContain('more.');
  });

  test('words wait for their write once a backlog has built up', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const stream = new HumanStream(
      async () => {},
      async (events) => {
        if (calls++ === 0) await gate;
        return events.map(() => null);
      },
    );
    void stream.emit(step());
    let acknowledged = 0;
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 400; index++) {
      const emitted = stream.emit(delta(`w${index}. `));
      pending.push(emitted);
      const settled = await Promise.race([emitted.then(() => true), Bun.sleep(0).then(() => false)]);
      if (!settled) break;
      acknowledged++;
    }
    // Acknowledged up to the backlog, then the next one waits on the write.
    expect(acknowledged).toBeGreaterThan(64);
    expect(acknowledged).toBeLessThan(400);
    release();
    await Promise.all(pending);
    await stream.drain();
  });
});