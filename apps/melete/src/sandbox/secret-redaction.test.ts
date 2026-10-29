/**
 * A background process's output, read in pieces through a computer that
 * keeps sealed values out. Whatever the cursor and the size of each read, and
 * whether the value was printed whole or is still being printed, no piece
 * shows any part of a value, and nothing else the process printed is lost.
 */
import { describe, expect, test } from 'bun:test';
import type { ProcessComputer, ProcessFacts } from './process-helper.ts';
import { redactCutBytes, sealedComputer } from './secret-redaction.ts';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/** One process's output in memory; the ring forgets everything before `oldest`. */
function oneProcess() {
  const state = { out: new Uint8Array(0), oldest: 0, live: true, lastLine: null as string | null };
  const facts = (): ProcessFacts => ({
    id: 'p',
    state: state.live ? 'running' : 'exited',
    exit_code: state.live ? null : 0,
    cursor: state.out.byteLength,
    oldest: state.oldest,
    last_line: state.lastLine,
    ports: [],
    members: state.live ? 1 : 0,
    started: 0,
  });
  const computer: ProcessComputer = {
    start: async () => ({
      outcome: 'started',
      boot: 'b',
      process: facts(),
      read: { from: 0, next: state.out.byteLength, dropped: 0, total: state.out.byteLength },
      data: state.out,
    }),
    status: async () => ({ boot: 'b', processes: [facts()], missing: [] }),
    read: async (_id, cursor, maxBytes) => {
      const total = state.out.byteLength;
      const from = Math.min(
        total,
        cursor < 0 ? Math.max(state.oldest, total - maxBytes) : Math.max(cursor, state.oldest),
      );
      const data = state.out.slice(from, Math.min(total, from + maxBytes));
      return {
        boot: 'b',
        process: facts(),
        read: { from, next: from + data.byteLength, dropped: from - Math.max(0, cursor), total },
        data,
      };
    },
    write: async () => ({ written: 0 }),
    signal: async () => ({ boot: 'b', process: facts() }),
    stop: async () => ({ boot: 'b', process: facts() }),
  };
  const print = (text: string) => {
    const joined = new Uint8Array(state.out.byteLength + encode(text).byteLength);
    joined.set(state.out);
    joined.set(encode(text), state.out.byteLength);
    state.out = joined;
  };
  return { state, computer, print };
}

/** A small seeded generator, so a failure can be replayed. */
function random(seed: number) {
  let value = seed >>> 0;
  return (below: number) => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value % below;
  };
}

/** Values in capitals and digits, never in the rest of the output. */
const VALUES = ['PK0123456789ABCDEF', 'OTP42', 'ABAB', 'X9'];
const filler = (next: (below: number) => number, length: number) =>
  Array.from({ length }, () => 'abc xyz=\n'[next(9)]).join('');
/** The output with every value taken out, as a reader should see it once each mark is dropped. */
const without = (text: string) => text.replaceAll('[redacted]', '');
const reference = (text: string) => {
  let out = text;
  for (const value of [...VALUES].sort((a, b) => b.length - a.length))
    out = out.replaceAll(value, '');
  return out;
};

describe('a computer that keeps sealed values out of what a process printed', () => {
  test('no piece of any read holds a part of a value, whatever its cursor and size', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const { state, computer, print } = oneProcess();
      let text = '';
      for (let parts = 0; parts < 6; parts++) {
        const piece =
          filler(next, next(12)) + (next(3) ? (VALUES[next(VALUES.length)] as string) : '');
        text += piece;
      }
      print(text);
      state.live = next(2) === 0;
      if (next(4) === 0) state.oldest = next(text.length);
      const sealed = sealedComputer(computer, async () => VALUES);
      for (let reads = 0; reads < 20; reads++) {
        const cursor = next(5) === 0 ? -1 : next(text.length + 2);
        const answer = await sealed.read('p', cursor, 1 + next(24), 0, AbortSignal.timeout(1000));
        const shown = decode(answer.data);
        expect([seed, cursor, shown, /[A-Z0-9]/.test(shown)]).toEqual([seed, cursor, shown, false]);
        expect(answer.read.next).toBeGreaterThanOrEqual(answer.read.from);
        expect(answer.read.next).toBeLessThanOrEqual(answer.read.total);
      }
    }
  });

  test('read page by page, it is the output with each value replaced, and nothing else gone', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const { state, computer, print } = oneProcess();
      const sealed = sealedComputer(computer, async () => VALUES);
      let text = '';
      let shown = '';
      let cursor = 0;
      // The process prints in bursts, sometimes cutting a value in two, while it is read.
      for (let bursts = 0; bursts < 8; bursts++) {
        let burst = filler(next, next(10));
        if (next(2)) burst += VALUES[next(VALUES.length)];
        const cut = next(burst.length + 1);
        print(burst.slice(0, cut));
        text += burst.slice(0, cut);
        for (let reads = 0; reads < 3; reads++) {
          const answer = await sealed.read('p', cursor, 1 + next(20), 0, AbortSignal.timeout(1000));
          shown += decode(answer.data);
          cursor = answer.read.next;
        }
        print(burst.slice(cut));
        text += burst.slice(cut);
      }
      state.live = false;
      for (let reads = 0; reads < 400 && cursor < text.length; reads++) {
        const answer = await sealed.read('p', cursor, 1 + next(20), 0, AbortSignal.timeout(1000));
        shown += decode(answer.data);
        cursor = answer.read.next;
      }
      expect([seed, /[A-Z0-9]/.test(shown)]).toEqual([seed, false]);
      expect([seed, without(shown)]).toEqual([seed, reference(text)]);
    }
  });

  test('the first output of a start and the last line a process reports are kept out too', async () => {
    const { state, computer, print } = oneProcess();
    print('ready\nkey=PK0123456789ABCDEF\nwaiting for PK0123');
    state.lastLine = 'key=PK0123456789ABCDEF';
    const sealed = sealedComputer(computer, async () => VALUES);
    const started = await sealed.start(
      { id: 'p', cwd: '/', command: 'x', halfBytes: 1, waitMs: 0, firstMaxBytes: 1 },
      AbortSignal.timeout(1000),
    );
    if (started.outcome !== 'started') throw new Error('not started');
    // The value's first bytes, still being printed, wait for the next read.
    expect(decode(started.data)).toBe('ready\nkey=[redacted]\nwaiting for ');
    expect(started.read.next).toBe(state.out.byteLength - 'PK0123'.length);
    expect(started.process.last_line).toBe('key=[redacted]');
    // A line the helper cut short at its limit loses the start of a value at its end.
    state.lastLine = `${'a'.repeat(234)}PK0123`;
    const status = await sealed.status('all', AbortSignal.timeout(1000));
    expect(status.processes[0]?.last_line).toBe('a'.repeat(234));
  });

  test('a last line longer than the window the helper reads it from loses the end of a value at its start', async () => {
    const { state, computer, print } = oneProcess();
    // The helper reads the last 4 KiB: a longer line starts wherever that window does.
    print(`${'a'.repeat(5000)}PK0123456789ABCDEF${'b'.repeat(4090)}`);
    state.lastLine = `CDEF${'b'.repeat(236)}`;
    const sealed = sealedComputer(computer, async () => VALUES);
    const status = await sealed.status('all', AbortSignal.timeout(1000));
    expect(status.processes[0]?.last_line).toBe('b'.repeat(236));
    // A short output's last line was never cut, and is left as it is.
    const short = oneProcess();
    short.print('CDEF and the rest\n');
    short.state.lastLine = 'CDEF and the rest';
    const answered = await sealedComputer(short.computer, async () => VALUES).status(
      'all',
      AbortSignal.timeout(1000),
    );
    expect(answered.processes[0]?.last_line).toBe('CDEF and the rest');
  });

  test('output cut off at the capture limit loses a value it cut in two', () => {
    expect(decode(redactCutBytes(encode('ok PK0123456789ABCDEF then PK01'), VALUES))).toBe(
      'ok [redacted] then ',
    );
    expect(decode(redactCutBytes(encode('plain output'), VALUES))).toBe('plain output');
  });
});
