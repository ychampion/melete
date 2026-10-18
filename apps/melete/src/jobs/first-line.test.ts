import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@melete/contracts';
import { FirstLine, isPlanLine } from './first-line.ts';

let seq = 0;
const base = () => {
  const local = seq++;
  return {
    attempt_id: 'att_first_line',
    local_seq: local,
    dedup_key: `d${local}`,
    at: new Date(0).toISOString(),
  };
};
const text = (value: string) => ({ ...base(), type: 'text_delta', text: value }) as RuntimeEvent;
const tool = () =>
  ({
    ...base(),
    type: 'tool_call_proposed',
    tool: 'web_search',
    call_id: 'c1',
    arguments: {},
  }) as RuntimeEvent;
const outcome = () =>
  ({
    ...base(),
    type: 'attempt_outcome',
    outcome: { kind: 'completed', summary: 'x', evidence: [] },
  }) as RuntimeEvent;

/** A gate whose acknowledgement has been shown, and what it recorded. */
function shownGate() {
  const recorded: RuntimeEvent[] = [];
  const gate = new FirstLine(async (event) => {
    recorded.push(event);
  }, true);
  expect(gate.beginShow()).toBe(true);
  return { gate, recorded };
}

const said = (events: RuntimeEvent[]) =>
  events.map((event) => (event.type === 'text_delta' ? event.text : `<${event.type}>`)).join('');

describe('a plan line', () => {
  test('is one short sentence saying what comes next', () => {
    for (const line of [
      'Checking the ECB rate.',
      'Drafting the reply to Sam.',
      "Let me look up tomorrow's forecast.",
      "I'll set that reminder now.",
      'Opening Wikipedia’s Ada Lovelace article.',
    ])
      expect(isPlanLine(line)).toBe(true);
  });

  test('is never content', () => {
    for (const line of [
      'Quick flag: the 23rd is a Friday this year.',
      "Here's a draft.",
      'It is 1.08 dollars to the euro. Source: ECB.',
      'Tomorrow in San Francisco the high is 67°F.',
      'Checking in: the meeting moved. Here is the new time.',
      `Checking ${'the rate '.repeat(30)}`,
    ])
      expect(isPlanLine(line)).toBe(false);
  });
});

describe('the first line of a turn', () => {
  test('with no acknowledgement, every event goes straight through, in order', async () => {
    const recorded: RuntimeEvent[] = [];
    const gate = new FirstLine(async (event) => {
      recorded.push(event);
    }, false);
    await gate.emit(text('Checking the rate.'));
    await gate.emit(tool());
    expect(said(recorded)).toBe('Checking the rate.<tool_call_proposed>');
    expect(gate.beginShow()).toBe(false);
  });

  test('the agent speaking first calls the acknowledgement off', async () => {
    const gate = new FirstLine(async () => {}, true);
    expect(gate.silent).toBe(true);
    await gate.emit(text('  '));
    expect(gate.silent).toBe(true);
    await gate.emit(text('Checking the rate.'));
    expect(gate.silent).toBe(false);
    expect(gate.beginShow()).toBe(false);
  });

  test('after the line is shown, what the agent wrote before its first step is not said', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Checking the '));
    await gate.emit(text('ECB rate.'));
    expect(recorded).toEqual([]);
    await gate.emit(tool());
    await gate.emit(text('It is 1.08.'));
    // Every event is still recorded, in order, so the record has no gap.
    expect(recorded.map((event) => event.local_seq)).toEqual(
      [...recorded].map((event) => event.local_seq).sort((a, b) => a - b),
    );
    expect(recorded).toHaveLength(4);
    expect(said(recorded)).toBe('<tool_call_proposed>It is 1.08.');
  });

  test('the model call starting is not a step: its plan line is still not said', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    // The engine reports each model call before the model writes anything.
    await gate.emit({ ...base(), type: 'turn_started', turn: 0 } as RuntimeEvent);
    expect(said(recorded)).toBe('<turn_started>');
    await gate.emit(text('Checking the ECB rate.'));
    await gate.emit(tool());
    expect(said(recorded)).toBe('<turn_started><tool_call_proposed>');
  });

  test('after silent steps, a plan line is not said, and anything else is', async () => {
    const planned = shownGate();
    await planned.gate.endShow(true);
    await planned.gate.emit(tool());
    await planned.gate.emit(text('Drafting your cover letter.'));
    await planned.gate.emit(tool());
    await planned.gate.emit(text('Here it is.'));
    expect(said(planned.recorded)).toBe('<tool_call_proposed><tool_call_proposed>Here it is.');
    const found = shownGate();
    await found.gate.endShow(true);
    await found.gate.emit(tool());
    await found.gate.emit(text('The table shows a change on the 17th.'));
    await found.gate.emit(tool());
    expect(said(found.recorded)).toBe(
      '<tool_call_proposed>The table shows a change on the 17th.<tool_call_proposed>',
    );
  });

  test('a plan line before a draft is not said; the draft goes out whole', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Drafting the reply'));
    await gate.emit(text(' to Sam.\n\nHi Sam,'));
    await gate.emit(text('\n\nThanks for the invite.'));
    await gate.emit(outcome());
    expect(said(recorded)).toBe('Hi Sam,\n\nThanks for the invite.<attempt_outcome>');
  });

  test('an answer that opens with content is never cut', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Quick flag: the 23rd is a Friday.\n\nHi Sam,'));
    await gate.emit(outcome());
    expect(said(recorded)).toBe('Quick flag: the 23rd is a Friday.\n\nHi Sam,<attempt_outcome>');
  });

  test('a short whole reply is the answer, even when it reads like a plan', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Setting it for 3 pm.'));
    await gate.emit(outcome());
    expect(said(recorded)).toBe('Setting it for 3 pm.<attempt_outcome>');
  });

  test('a long first paragraph goes out without waiting for its end', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Checking '.repeat(30)));
    expect(said(recorded)).toBe('Checking '.repeat(30));
  });

  test('words that arrive while the line is written wait, and win when it is not shown', async () => {
    const { gate, recorded } = shownGate();
    await gate.emit(text('Checking the rate.'));
    await gate.emit(tool());
    expect(recorded).toEqual([]);
    await gate.endShow(false);
    expect(said(recorded)).toBe('Checking the rate.<tool_call_proposed>');
  });

  test('words held while the line was written are not said twice once it is shown', async () => {
    const { gate, recorded } = shownGate();
    await gate.emit(text('Checking the rate.'));
    await gate.emit(tool());
    await gate.emit(text('It is 1.08.'));
    await gate.endShow(true);
    expect(said(recorded)).toBe('<tool_call_proposed>It is 1.08.');
  });

  test('the end of the attempt lets out whatever is still held', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Checking'));
    await gate.drain();
    expect(said(recorded)).toBe('Checking');
  });

  test('an event that fails to record does not stop the next one', async () => {
    const recorded: RuntimeEvent[] = [];
    const gate = new FirstLine(async (event) => {
      if (event.type === 'tool_call_proposed') throw new Error('refused');
      recorded.push(event);
    }, false);
    await expect(gate.emit(tool())).rejects.toThrow('refused');
    await gate.emit(text('Next.'));
    expect(said(recorded)).toBe('Next.');
  });
});
