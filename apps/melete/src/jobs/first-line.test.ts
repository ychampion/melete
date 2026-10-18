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

/**
 * Lines that carry an answer, a finding, a problem or a request, whatever
 * their first words: none of them may ever be dropped, wherever they come.
 */
const REAL_ANSWERS = [
  "I'll be honest, the flight is $420.",
  "I've checked: it's 4pm.",
  "I'll go with the $420 fare on Delta.",
  "I'll need your passport number to book this.",
  "I'll need your address.",
  "I'll be honest.",
  "I'm seeing two flights at $420 and $510.",
  "I'm seeing two flights, then I'll pick the cheaper one.",
  "I'm getting an error from the airline site.",
  "I'm missing your address.",
  "I'm thinking the 22nd works best.",
  "I'm guessing you meant Thursday.",
  "I'm assuming you meant the Lisbon trip.",
  "I'm not able to reach the site.",
  'Seeing two flights at $420 and $510.',
  'Getting a 404 from the airline site.',
  'Getting an error from the airline site.',
  'Showing 3 flights under $500.',
  'Running into a login wall on the site.',
  'Having trouble reaching the site.',
  'Finding nothing for that date.',
  'Leaving at 7 is safest.',
  'Booking it would cost $420.',
  "It's 4 pm.",
  'The flight is $420.',
  'Done.',
  'Yes.',
  'Sent.',
  'Booked.',
  'Reminder set.',
  'Saved to your notes.',
  'Je vais vérifier le vol.',
  'Voy a revisar el vuelo.',
  'Revisando el vuelo ahora.',
  'Ich prüfe den Flug.',
  '我来查一下航班。',
  'मैं फ़्लाइट देखता हूँ।',
  'Verificando o voo agora.',
  'Der Flug kostet 420 €.',
];

const textOf = (event: RuntimeEvent) => (event.type === 'text_delta' ? event.text : '');
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

  test('a word in -ing that is not the agent at work is content', () => {
    for (const line of [
      'Nothing changed since Monday.',
      'Nothing new in your inbox.',
      'Everything is booked for Friday.',
      'Something came up with the 4 pm call.',
      'Meeting moved to Thursday at 3 pm.',
      'Booking confirmed for 7 pm.',
      'According to the ECB the rate is 1.08.',
      'Starting Monday, the gym opens at 6.',
      'Depending on traffic, it takes 20 minutes.',
      'Interesting question.',
      'Morning! Your first meeting is at 9.',
      'Parking is free after 6 pm.',
      'Bring an umbrella tomorrow.',
      "I'm not sure the 23rd is a Thursday.",
      'Let me know if 4 pm works.',
      "I'll be honest, it is a bad deal.",
      'Setting your reminder for 9:37 pm.',
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: false });
  });

  test('a statement of intent with when it happens after a comma is a plan', () => {
    for (const line of [
      "I'll set a timer for 7:14 AM, three minutes from now.",
      "I'll set a timer for 7:07 AM, three minutes from your request.",
      "I'll set a reminder for 9 pm, an hour from now.",
      "I'll check the forecast, then tell you.",
      "Sure, I'll draft it now, then check the word count.",
      "I'm setting a timer for 7:14 AM, 3 minutes from now.",
      "Let me pull the file first, then I'll run the numbers.",
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: true });
  });

  test('a comma after intent that carries a fact, a result or a condition is content', () => {
    for (const line of [
      "I'll be honest, it is a bad deal.",
      "I'll check, but the rate is 1.08.",
      "I'll convert it at 1.08, the ECB rate today.",
      "I'll book the taxi, Sam lands tonight.",
      "I'll set it for 7:14 AM, which is three minutes from now.",
      "I'll set a timer for 7:14 AM, here's why.",
      "I'll remind you at 7:14 AM, three minutes from now: stretch.",
      "I'll run the numbers, then the total is $155,233.",
      "I'll check the rate, then the euro fell.",
      "I'll message you, when it's done.",
      'Let me know by 5 pm, then I will book it.',
      "I'll need your address, since the form asks for it.",
      "If it rains, I'll move it indoors.",
      'Setting a reminder for 7:14 AM, three minutes from now.',
      "I'll set it for 9:37 pm.",
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: false });
  });

  test('the lines a live run showed after the acknowledgement: the doubles are plans', () => {
    // Each came after an acknowledgement line saying the same thing.
    for (const line of [
      "I'll run the numbers on the file.",
      "I'll draft it and check the word count.",
      "I'll set a timer for 7:14 AM, three minutes from now.",
      "I'll set a timer for 7:07 AM, three minutes from your request.",
      "I'll check what I know about your book club first.",
      'Checking what I know about your book club first.',
      'Searching Wikipedia for Ada Lovelace.',
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: true });
  });

  test('the lines a live run showed after the acknowledgement: the answers are content', () => {
    for (const line of [
      "Here are three dinner ideas for tonight. They're all vegetarian and peanut-free:",
      'Here are three dinners that are vegetarian and peanut-free:',
      'Your reminder to stretch is set for 7:14 AM, three minutes from now.',
      "Your reminder to stretch is set for 7:06 AM, three minutes after you asked. I'll message you then.",
      'For 2025:',
      'Bills total 1,850 + 210 + 340 + 65 = $2,465, so $2,735 is left each month.',
      "The weather tool only returned today, so I'll pull tomorrow's forecast from Open-Meteo.",
      "I don't have your club's details saved, so I'll build the deck with marked gaps.",
      "The search went straight to her article. Now I'll read the birth date.",
      "I found the range on the Fed's page. I'll check it against the statement.",
      "Got it: you're vegetarian.",
      "Here's your finished cover letter at 203 words, signature included.",
      '1 USD is about 0.89 EUR right now, so 1 EUR is about 1.12 USD.',
      'Tomorrow (Mon, Oct 19) the forecast high is about 62°F.',
      "No internet access here, so I can't install a library. I'll build the file directly.",
      'Dear Hiring Manager,',
      "Here's a relaxed Lisbon plan, with one or two things a day and long breaks.",
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: false });
  });

  test('a line that reports what was found, what went wrong or what is needed is content', () => {
    for (const line of REAL_ANSWERS)
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: false });
  });

  test('a step with a time and why the agent takes it is a plan; a time read back alone is not', () => {
    for (const line of [
      'Setting a timer for 7:53 AM so I can remind you to stretch.',
      "I'll set a timer for 7:53 AM so I can remind you to stretch.",
      'Setting a reminder for 9:37 pm so that I can nudge you.',
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: true });
    for (const line of [
      'Setting your reminder for 9:37 pm.',
      "I'll set it for 9:37 pm.",
      'Setting a timer for 7:53 AM so you can stretch.',
      'Setting a timer for 7:53 AM so I can tell you the rate is 1.08.',
      'Setting a timer for 7:53 AM so I can remind you, since the call is at 8.',
      'Setting a timer for 7:53 AM so I can remind you about the $420 fare.',
      "I'm guessing 7:53 AM so I can remind you before the call.",
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: false });
  });

  test('a plan may open with a short lead-in or run to a second plan sentence', () => {
    for (const line of [
      'Sure — let me check.',
      'On it. Checking the rate now.',
      "Drafting your cover letter. I'll check the word count first.",
      "I'm checking your calendar.",
      "Got it, I'll set that reminder.",
    ])
      expect({ line, plan: isPlanLine(line) }).toEqual({ line, plan: true });
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

  test('a short answer before a step is not a plan line, and is said', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Quick flag: Thursday is the 22nd, not the 23rd.'));
    await gate.emit(tool());
    expect(said(recorded)).toBe(
      'Quick flag: Thursday is the 22nd, not the 23rd.<tool_call_proposed>',
    );
    const noted = shownGate();
    await noted.gate.endShow(true);
    await noted.gate.emit(text("You're free at 4 pm on Friday"));
    await noted.gate.emit(text('.'));
    await noted.gate.emit(tool());
    expect(said(noted.recorded)).toBe("You're free at 4 pm on Friday.<tool_call_proposed>");
  });

  test('a step taken before the line was shown counts as a step', async () => {
    const recorded: RuntimeEvent[] = [];
    const gate = new FirstLine(async (event) => {
      recorded.push(event);
    }, true);
    // The agent went straight to a step, in silence, before the deadline.
    await gate.emit(tool());
    expect(gate.beginShow()).toBe(true);
    await gate.endShow(true);
    await gate.emit(text('The ECB rate is 1.08 today.'));
    await gate.emit(tool());
    expect(said(recorded)).toBe(
      '<tool_call_proposed>The ECB rate is 1.08 today.<tool_call_proposed>',
    );
  });

  test('in a later attempt of an acknowledged turn, a plan line after steps is not said', async () => {
    const recorded: RuntimeEvent[] = [];
    // An earlier attempt showed the line; this one says nothing until after its steps.
    const gate = new FirstLine(
      async (event) => {
        recorded.push(event);
      },
      false,
      true,
    );
    expect(gate.silent).toBe(false);
    expect(gate.beginShow()).toBe(false);
    await gate.emit({ ...base(), type: 'turn_started', turn: 0 } as RuntimeEvent);
    await gate.emit(tool());
    await gate.emit(text("I'll run the numbers on the"));
    await gate.emit(text(' file.'));
    await gate.emit(tool());
    await gate.emit(text('For 2025: the total was $155,233.'));
    await gate.drain();
    expect(said(recorded)).toBe(
      '<turn_started><tool_call_proposed><tool_call_proposed>For 2025: the total was $155,233.',
    );
    expect(recorded).toHaveLength(6);
  });

  test('in a later attempt of an acknowledged turn, an answer after steps is said whole', async () => {
    for (const answer of [
      "Here are three dinner ideas for tonight. They're all vegetarian and peanut-free:",
      'Your reminder to stretch is set for 7:14 AM, three minutes from now.',
      'The table shows a change on the 17th.',
    ]) {
      const recorded: RuntimeEvent[] = [];
      const gate = new FirstLine(
        async (event) => {
          recorded.push(event);
        },
        false,
        true,
      );
      await gate.emit(tool());
      await gate.emit(text(answer));
      await gate.emit(tool());
      await gate.emit(text(' More.'));
      await gate.drain();
      expect(said(recorded)).toBe(`<tool_call_proposed>${answer}<tool_call_proposed> More.`);
    }
  });

  test('in a later attempt of an acknowledged turn, a short whole reply is the answer', async () => {
    const recorded: RuntimeEvent[] = [];
    const gate = new FirstLine(
      async (event) => {
        recorded.push(event);
      },
      false,
      true,
    );
    await gate.emit(tool());
    await gate.emit(text("I'll set a timer for 7:14 AM, three minutes from now."));
    await gate.emit(outcome());
    expect(said(recorded)).toBe(
      "<tool_call_proposed>I'll set a timer for 7:14 AM, three minutes from now.<attempt_outcome>",
    );
  });

  test('in a later attempt of an acknowledged turn, the saved reply leaves out its plan line', async () => {
    const recorded: RuntimeEvent[] = [];
    const gate = new FirstLine(
      async (event) => {
        recorded.push(event);
      },
      false,
      true,
    );
    const reply = "I'll draft it and check the word count.\n\nDear Hiring Manager,";
    await gate.emit(text(reply));
    await gate.emit({
      ...base(),
      type: 'attempt_outcome',
      outcome: { kind: 'completed', summary: reply, evidence: [] },
    } as RuntimeEvent);
    expect(said(recorded)).toBe('Dear Hiring Manager,<attempt_outcome>');
    const ended = recorded.at(-1) as Extract<RuntimeEvent, { type: 'attempt_outcome' }>;
    expect(ended.outcome).toMatchObject({ summary: 'Dear Hiring Manager,' });
  });

  test('a first line that only looks like a plan is said', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Nothing new in your inbox.\nSam has not replied yet.'));
    await gate.emit(outcome());
    expect(said(recorded)).toBe(
      'Nothing new in your inbox.\nSam has not replied yet.<attempt_outcome>',
    );
  });

  test('the end of the attempt waits for a line being shown, then judges what was held', async () => {
    const { gate, recorded } = shownGate();
    await gate.emit(text('Checking the rate.'));
    await gate.emit(tool());
    const drained = gate.drain();
    await gate.endShow(true);
    await drained;
    expect(said(recorded)).toBe('<tool_call_proposed>');
  });

  test('the saved answer leaves out a plan line dropped from the reply it ends on', async () => {
    const final = shownGate();
    await final.gate.endShow(true);
    await final.gate.emit(text('Drafting the reply to Sam.\n\nHi Sam,\n\nNot Thursday.'));
    await final.gate.emit(outcome());
    const reply = (summary: string) => ({ kind: 'completed' as const, summary, evidence: [] });
    expect(
      final.gate.settled(reply('Drafting the reply to Sam.\n\nHi Sam,\n\nNot Thursday.')),
    ).toEqual(reply('Hi Sam,\n\nNot Thursday.'));
    expect(
      final.gate.settled({
        kind: 'waiting_for_input',
        question: 'Which Sam?',
        draft: 'Drafting the reply to Sam.\nHi Sam,',
      }),
    ).toMatchObject({ draft: 'Hi Sam,' });
    // A plan line dropped before a step was another message: the answer stands.
    const earlier = shownGate();
    await earlier.gate.endShow(true);
    await earlier.gate.emit(text('Drafting the reply to Sam.\n\nOne moment.'));
    await earlier.gate.emit(tool());
    await earlier.gate.emit(text('Drafting the reply to Sam. It is 80 words.'));
    expect(earlier.gate.settled(reply('Drafting the reply to Sam. It is 80 words.'))).toEqual(
      reply('Drafting the reply to Sam. It is 80 words.'),
    );
    // Nothing dropped: the outcome is the runtime's own.
    const open = new FirstLine(async () => {}, false);
    const same = reply('Checking the rate.\nIt is 1.08.');
    expect(open.settled(same)).toBe(same);
  });

  test('the outcome event carries the answer as it was shown', async () => {
    const { gate, recorded } = shownGate();
    await gate.endShow(true);
    await gate.emit(text('Checking your calendar.\nYou are free at 4 pm.'));
    await gate.emit({
      ...base(),
      type: 'attempt_outcome',
      outcome: {
        kind: 'completed',
        summary: 'Checking your calendar.\nYou are free at 4 pm.',
        evidence: [],
      },
    } as RuntimeEvent);
    const ended = recorded.at(-1) as Extract<RuntimeEvent, { type: 'attempt_outcome' }>;
    expect(ended.outcome).toMatchObject({ summary: 'You are free at 4 pm.' });
    expect(said(recorded)).toBe('You are free at 4 pm.<attempt_outcome>');
  });

  test('in any order of words, steps and the line, nothing but one plan opening is lost', async () => {
    // A small seeded generator, so a failure names the case that broke.
    let state = 7;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
    const pieces = [
      'Checking the rate.',
      'Checking ',
      'the rate.',
      '\n\n',
      'It is 1.08.',
      'Nothing changed.',
      'Hi Sam,',
      ' ',
      'Drafting the reply. ',
      "I'll look it up.",
      'Quick flag: the 23rd is a Friday.',
      'x'.repeat(120),
    ];
    for (let round = 0; round < 3_000; round++) {
      const recorded: RuntimeEvent[] = [];
      const gate = new FirstLine(async (event) => {
        recorded.push(event);
      }, true);
      const sent: RuntimeEvent[] = [];
      const steps = 1 + Math.floor(random() * 8);
      const begin = Math.floor(random() * (steps + 1));
      const end = begin + Math.floor(random() * (steps + 1 - begin));
      const shown = random() < 0.7;
      let begun: boolean | null = null;
      let spokeFirst = false;
      for (let at = 0; at <= steps; at++) {
        if (at === begin) begun = gate.beginShow();
        if (at === end && begun) void gate.endShow(shown);
        if (at === steps) break;
        const event = random() < 0.3 ? tool() : text(pick(pieces));
        if (begun === null && textOf(event).trim()) spokeFirst = true;
        sent.push(event);
        void gate.emit(event);
      }
      if (begun && end > steps) void gate.endShow(shown);
      await gate.drain();
      const label = `round ${round}: ${JSON.stringify(sent.map((event) => textOf(event) || '<step>'))} begin ${begin} end ${end} shown ${shown}`;
      // Every event, once, in order: the record has no gap.
      expect({ label, seqs: recorded.map((event) => event.local_seq) }).toEqual({
        label,
        seqs: sent.map((event) => event.local_seq),
      });
      if (spokeFirst) expect({ label, begun }).toEqual({ label, begun: false });
      const before = sent.map(textOf).join('');
      const after = recorded.map(textOf).join('');
      if (!begun || !shown) {
        expect({ label, after }).toEqual({ label, after: before });
        continue;
      }
      // At most the opening is gone, and only when it reads as a plan.
      if (after !== before) {
        const lost = before.trimStart();
        const kept = after.trimStart();
        const gone = lost.endsWith(kept) ? lost.slice(0, lost.length - kept.length) : null;
        expect({ label, gone: gone !== null }).toEqual({ label, gone: true });
        expect({ label, plan: isPlanLine(gone ?? '') }).toEqual({ label, plan: true });
      }
    }
  });

  test('with steps first, in this attempt or a later one, only a plan opening is ever lost', async () => {
    let state = 11;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
    // Lines a live run showed after the acknowledgement, plans and answers, and pieces of them.
    const pieces = [
      "I'll run the numbers on the",
      ' file.',
      "I'll draft it and check the word count.",
      "I'll set a timer for 7:14 AM, three minutes from now.",
      'Here are three dinner ideas for tonight.',
      " They're all vegetarian and peanut-free:",
      'Your reminder to stretch is set for 7:14 AM, three minutes from now.',
      'For 2025:',
      '\n\n',
      'Total: $155,233.',
      "I'll check, but the rate is 1.08.",
      "I'll book the taxi, Sam lands tonight.",
      'Dear Hiring Manager,',
      ' ',
      '',
      'Searching Wikipedia for Ada Lovelace.',
      'x'.repeat(120),
    ];
    const step = () =>
      random() < 0.5
        ? tool()
        : ({ ...base(), type: 'tool_result', call_id: 'c1', ok: true, result: {} } as RuntimeEvent);
    for (let round = 0; round < 3_000; round++) {
      const recorded: RuntimeEvent[] = [];
      // A later attempt of a turn whose line an earlier attempt showed, or this
      // attempt's own line shown before its first event.
      const later = random() < 0.5;
      const gate = new FirstLine(
        async (event) => {
          recorded.push(event);
        },
        !later,
        later,
      );
      if (!later) {
        expect(gate.beginShow()).toBe(true);
        await gate.endShow(true);
      }
      const sent: RuntimeEvent[] = [];
      // Steps first, as an attempt that works before it writes.
      for (let count = Math.floor(random() * 3); count > 0; count--) sent.push(step());
      for (let count = 1 + Math.floor(random() * 6); count > 0; count--)
        sent.push(random() < 0.3 ? step() : text(pick(pieces)));
      if (random() < 0.5) sent.push(outcome());
      for (const event of sent) void gate.emit(event);
      await gate.drain();
      const label = `round ${round}: later ${later} ${JSON.stringify(sent.map((event) => textOf(event) || `<${event.type}>`))}`;
      expect({ label, seqs: recorded.map((event) => event.local_seq) }).toEqual({
        label,
        seqs: sent.map((event) => event.local_seq),
      });
      const before = sent.map(textOf).join('');
      const after = recorded.map(textOf).join('');
      if (after !== before) {
        const lost = before.trimStart();
        const kept = after.trimStart();
        const gone = lost.endsWith(kept) ? lost.slice(0, lost.length - kept.length) : null;
        expect({ label, gone: gone !== null }).toEqual({ label, gone: true });
        expect({ label, plan: isPlanLine(gone ?? '') }).toEqual({ label, plan: true });
      }
    }
  });

  test('a real answer is said whole, in any attempt, after any steps, cut anywhere', async () => {
    // Checked against a fixed list of answers, not against the gate's own
    // reading of them, so a line it takes for a plan by mistake shows here.
    let state = 23;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
    const step = () =>
      random() < 0.5
        ? tool()
        : ({ ...base(), type: 'tool_result', call_id: 'c1', ok: true, result: {} } as RuntimeEvent);
    for (let round = 0; round < 3_000; round++) {
      const recorded: RuntimeEvent[] = [];
      // A later attempt of an acknowledged turn, or this attempt's own line
      // shown before its words, or shown after its first steps.
      const mode = pick(['later', 'shown', 'shown_after_steps'] as const);
      const gate = new FirstLine(
        async (event) => {
          recorded.push(event);
        },
        mode !== 'later',
        mode === 'later',
      );
      if (mode === 'shown') {
        gate.beginShow();
        await gate.endShow(true);
      }
      const sent: RuntimeEvent[] = [];
      const emit = async (event: RuntimeEvent) => {
        sent.push(event);
        await gate.emit(event);
      };
      for (let count = Math.floor(random() * 3); count > 0; count--) await emit(step());
      if (mode === 'shown_after_steps') {
        gate.beginShow();
        await gate.endShow(true);
      }
      // The answer, cut into pieces at random, empty pieces included.
      const answer = pick(REAL_ANSWERS);
      const cuts = [0, answer.length];
      for (let count = Math.floor(random() * 4); count > 0; count--)
        cuts.push(Math.floor(random() * (answer.length + 1)));
      cuts.sort((a, b) => a - b);
      for (let at = 0; at + 1 < cuts.length; at++)
        await emit(text(answer.slice(cuts[at], cuts[at + 1])));
      const then = pick(['step', 'line', 'outcome', 'end'] as const);
      if (then === 'step') await emit(step());
      if (then === 'line') await emit(text('\n\nMore to follow.'));
      if (then === 'outcome') await emit(outcome());
      await gate.drain();
      const label = `round ${round}: ${mode} ${JSON.stringify(sent.map((event) => textOf(event) || `<${event.type}>`))}`;
      expect({ label, seqs: recorded.map((event) => event.local_seq) }).toEqual({
        label,
        seqs: sent.map((event) => event.local_seq),
      });
      expect({ label, said: recorded.map(textOf).join('').includes(answer) }).toEqual({
        label,
        said: true,
      });
    }
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
