import { describe, expect, test } from 'bun:test';
import { type AttemptOutcome, humanText, type RuntimeEvent } from '@melete/contracts';
import { FirstLine } from './first-line.ts';
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

describe('asides in the middle of a message', () => {
  test('an aside while no words are held leaves the message open', async () => {
    for (const aside of [reasoning('think'), { ...base(), type: 'stalled' } as RuntimeEvent]) {
      const { stream, recorded, shown } = recorder();
      const sent = [delta('Booked it'), aside, delta(' — the room is yours.')];
      for (const event of sent) await stream.emit(event);
      await stream.drain();
      expect(shown()).toBe(humanText('Booked it — the room is yours.'));
      expect(recorded.map((event) => event.local_seq)).toEqual(
        sent.map((event) => event.local_seq),
      );
    }
  });
});

describe('behind the first-line gate', () => {
  // A fixed sequence of choices, so a failure can be replayed.
  let state = 7;
  const chance = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const later = async () => {
    const roll = chance();
    if (roll < 0.5)
      for (let tick = 0; tick < Math.floor(roll * 10); tick++) await Promise.resolve();
    else if (roll < 0.6) await new Promise((done) => setImmediate(done));
  };
  const replies = [
    'Booked it — the room is yours. Hours are 9–5.',
    'The rate is 1.08 — up from 1.07 — since Monday.\nAnything else?',
    'Here is the list:\n\n- one — two\n- three\n\nDone — thanks.',
  ];

  test('every word reaches the record in the order it was said, however slowly each is written', async () => {
    for (let round = 0; round < 300; round++) {
      const reply = replies[round % replies.length] as string;
      const sent: RuntimeEvent[] = [];
      for (let at = 0; at < reply.length; ) {
        const size = 1 + Math.floor(chance() * 8);
        sent.push(delta(reply.slice(at, at + size)));
        if (chance() < 0.15) sent.push(reasoning('think'));
        at += size;
      }
      sent.push(done(reply));
      const recorded: RuntimeEvent[] = [];
      const stream = new HumanStream(async (event) => {
        await later();
        recorded.push(event);
      });
      const acknowledging = chance() < 0.7;
      const gate = new FirstLine((event) => stream.emit(event), acknowledging);
      // The acknowledgement, shown or not, at any point in the reply.
      const acknowledgement = (async () => {
        await later();
        if (!acknowledging || !gate.beginShow()) return;
        await later();
        await gate.endShow(chance() < 0.5);
      })();
      const waits = chance() < 0.5;
      const pending: Promise<void>[] = [];
      for (const event of sent) {
        const out = gate.emit(event);
        if (waits) await out;
        else pending.push(out);
        await later();
      }
      await Promise.all(pending);
      gate.cancel();
      await gate.drain();
      await stream.drain();
      await acknowledgement;
      expect(recorded.map((event) => event.local_seq)).toEqual(
        sent.map((event) => event.local_seq),
      );
      expect(
        recorded
          .filter((event) => event.type === 'text_delta')
          .map((event) => (event as { text: string }).text)
          .join(''),
      ).toBe(humanText(reply));
    }
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
