import { describe, expect, test } from 'bun:test';
import { HumanText, humanText, SHORT_REPLY_CHARACTERS } from './human-text.ts';

const EM = '—';
const EN = '–';

/** The pass fed in the given pieces, as a stream would feed it. */
function streamed(pieces: readonly string[], mode: 'reply' | 'draft' = 'reply'): string {
  const pass = new HumanText(mode);
  let shown = '';
  for (const piece of pieces) shown += pass.push(piece);
  return shown + pass.end();
}

/** A small seeded generator, so a failure names a split that can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomSplit(text: string, random: () => number): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(random() * 7);
    pieces.push(text.slice(at, at + size));
    at += size;
  }
  return pieces;
}

describe('dashes become the punctuation a person types', () => {
  test.each([
    [`We have three options ${EM} all bad.`, 'We have three options: all bad.'],
    [`We have three options${EM}all bad.`, 'We have three options: all bad.'],
    [`It's booked ${EM} I sent the form at 2.`, "It's booked. I sent the form at 2."],
    [`The fix ${EM} restart the router.`, 'The fix: restart the router.'],
    [
      `I bought what you listed ${EM} milk, eggs and bread.`,
      'I bought what you listed: milk, eggs and bread.',
    ],
    [`The plan ${EM} if it works ${EM} saves an hour.`, 'The plan, if it works, saves an hour.'],
    [
      `The plan ${EM} if it works, and it should ${EM} saves an hour.`,
      'The plan (if it works, and it should) saves an hour.',
    ],
    [`It's cheaper ${EM} but slower.`, "It's cheaper, but slower."],
    [`It's cheaper ${EN} but slower.`, "It's cheaper, but slower."],
    [`It's cheaper -- but slower.`, "It's cheaper, but slower."],
    [`The office is open ${EM} until six.`, 'The office is open, until six.'],
    [`The rate went up ${EM} again.`, 'The rate went up, again.'],
    [`The trip ends on Friday ${EM}`, 'The trip ends on Friday...'],
  ])('%s', (input, output) => {
    expect(humanText(input)).toBe(output);
  });

  test.each([
    // A full clause or an instruction after the dash is a sentence of its own.
    [
      `Already done ${EM} the bump to $750 is on record.`,
      'Already done. The bump to $750 is on record.',
    ],
    [
      `The dropdown didn't take ${EM} let me look at the page.`,
      "The dropdown didn't take. Let me look at the page.",
    ],
    [
      `Both dates are off the receipt ${EM} note the invoice is dated tomorrow.`,
      'Both dates are off the receipt. Note the invoice is dated tomorrow.',
    ],
    [
      `It's not shrinking ${EM} if it fills, the host goes down.`,
      "It's not shrinking. If it fills, the host goes down.",
    ],
    [`Seattle it is ${EM} I used Fremont, not LA.`, 'Seattle it is. I used Fremont, not LA.'],
    // A word that opens the reply, or a list label, introduces what follows.
    [`Noted ${EM} step-free hotels only.`, 'Noted: step-free hotels only.'],
    [
      `- **Sofia** ${EM} contact the payment provider.`,
      '- **Sofia**: contact the payment provider.',
    ],
    [`1. **Groceries** ${EM} $865.15`, '1. **Groceries**: $865.15'],
    // Never a second colon in one sentence.
    [
      `Done ${EM} the PDF is in your Files: $155,233 total, 2,817 orders and a best month.`,
      'Done. The PDF is in your Files: $155,233 total, 2,817 orders and a best month.',
    ],
    [
      `It's still empty ${EM} typing into it waits on you, and I stopped there.`,
      "It's still empty, typing into it waits on you, and I stopped there.",
    ],
  ])('%s', (input, output) => {
    expect(humanText(input, 'draft')).toBe(output);
  });

  test('an aside never reaches across bold text or a parenthesis', () => {
    expect(
      humanText(`1. **2026-01-15 ${EM} Netflix, $15.49** (two) ${EM} two charges`, 'draft'),
    ).toBe('1. **2026-01-15: Netflix, $15.49** (two), two charges');
    expect(
      humanText(
        `Two are overdue: Harbor (HLE-3391, due Oct 20 ${EM} $1,860) and Pacific (due Oct 1 ${EM} $2,240).`,
      ),
    ).toBe(
      'Two are overdue: Harbor (HLE-3391, due Oct 20, $1,860) and Pacific (due Oct 1, $2,240).',
    );
  });

  test('a dash that closes an aside at the end of a sentence leaves only the sentence mark', () => {
    expect(humanText(`I called the clinic ${EM} twice ${EM}.`)).toBe('I called the clinic, twice.');
  });

  test('a dash at the end of a line introduces what comes next', () => {
    expect(humanText(`Here is what I found ${EM}\nThe rate is 4.1%.`)).toBe(
      'Here is what I found:\nThe rate is 4.1%.',
    );
  });

  test('ranges and compounds take a hyphen', () => {
    expect(humanText(`Open 9${EN}5 on weekdays.`)).toBe('Open 9-5 on weekdays.');
    expect(humanText(`Open 9:00${EN}17:00.`)).toBe('Open 9:00-17:00.');
    expect(humanText(`Open Mon${EN}Fri.`)).toBe('Open Mon-Fri.');
    expect(humanText(`Flights for $10${EN}$20 each.`)).toBe('Flights for $10-$20 each.');
    expect(humanText(`The score was 3 ${EN} 2.`)).toBe('The score was 3-2.');
    expect(humanText(`Pages 10${EM}12 cover it.`)).toBe('Pages 10-12 cover it.');
    expect(humanText(`The New York${EN}London flight is late.`)).toBe(
      'The New York-London flight is late.',
    );
  });

  test('no dash used as punctuation survives an ordinary English reply', () => {
    const replies = [
      `Done ${EM} I moved it to Thursday ${EM} and told Sam.`,
      `Two things${EM}the form and the fee.`,
      `Yes ${EN} the store opens at 9.`,
      `It's there -- in your Files.`,
    ];
    for (const reply of replies) expect(humanText(reply)).not.toMatch(/[—–]| -- /);
  });
});

describe('what the pass never touches', () => {
  test('fenced code', () => {
    const text = `Run this:\n\n\`\`\`sh\ncurl -s https://x.dev ${EM} --fail\necho "a ${EM} b"\n\`\`\`\n\nThen check ${EM} it works.`;
    expect(humanText(text)).toBe(
      `Run this:\n\n\`\`\`sh\ncurl -s https://x.dev ${EM} --fail\necho "a ${EM} b"\n\`\`\`\n\nThen check, it works.`,
    );
  });

  test('tilde fences and indented code', () => {
    const text = `~~~\na ${EM} b\n~~~\n    x ${EM} y\nIt works ${EM} mostly.`;
    expect(humanText(text)).toBe(`~~~\na ${EM} b\n~~~\n    x ${EM} y\nIt works, mostly.`);
  });

  test('inline code', () => {
    expect(humanText(`Use \`a ${EM} b\` here ${EM} not there.`)).toBe(
      `Use \`a ${EM} b\` here, not there.`,
    );
  });

  test('links and addresses', () => {
    expect(humanText(`See https://example.com/a${EM}b for it.`)).toBe(
      `See https://example.com/a${EM}b for it.`,
    );
    expect(humanText(`See [the page](https://example.com/a${EM}b) for it.`)).toBe(
      `See [the page](https://example.com/a${EM}b) for it.`,
    );
    expect(humanText(`Mail mailto:a${EM}b@example.com now.`)).toBe(
      `Mail mailto:a${EM}b@example.com now.`,
    );
  });

  test('quoted words, in straight or curly quotes, and block quotes', () => {
    expect(humanText(`She wrote "back by six ${EM} promise" this morning.`)).toBe(
      `She wrote "back by six ${EM} promise" this morning.`,
    );
    expect(humanText(`She wrote “back by six ${EM} promise” this morning.`)).toBe(
      `She wrote “back by six ${EM} promise” this morning.`,
    );
    expect(humanText(`> I can do Tuesday ${EM} maybe Wednesday.\n\nTuesday works.`)).toBe(
      `> I can do Tuesday ${EM} maybe Wednesday.\n\nTuesday works.`,
    );
  });

  test('tables', () => {
    const table = `| Day | Hours |\n|---|---|\n| Mon ${EM} Fri | 9 ${EN} 5 |`;
    expect(humanText(table)).toBe(table);
  });

  test('a dash that opens a line, as a list mark or dialogue', () => {
    const text = `${EM} Where are you?\n${EM} Home.\n- one\n- two`;
    expect(humanText(text, 'draft')).toBe(text);
  });

  test('other languages keep their dashes', () => {
    for (const text of [
      `Москва ${EM} столица России.`,
      `Warszawa ${EN} to jest stolica Polski, nie miasto.`,
      `C'est la vie ${EM} et les gens.`,
      `東京${EM}大阪`,
      `Das ist ${EM} nicht wahr.`,
    ])
      expect(humanText(text)).toBe(text);
  });

  test('a hyphen in a word, a flag or a minus sign', () => {
    const text = 'A well-known fix: run git log --oneline, and -5 is below zero.';
    expect(humanText(text)).toBe(text);
  });
});

describe('machine tells in a reply', () => {
  test('a stock opener before the real words goes', () => {
    expect(humanText("Certainly! Here's the engineer's slot for Thursday.")).toBe(
      "Here's the engineer's slot for Thursday.",
    );
    expect(humanText('Great question! It depends on the plan.')).toBe('It depends on the plan.');
    expect(humanText('Absolutely, here is the draft.')).toBe('Here is the draft.');
    expect(humanText("Sure! Sure thing! I'll do it.")).toBe("I'll do it.");
  });

  test('a yes that answers the question stays', () => {
    // The person asked "Can I cancel?": the yes is the answer, not a tell.
    for (const text of [
      'Absolutely. Fees apply after Friday.',
      'Certainly. Not today, though.',
      'Of course! Dogs are welcome on the patio.',
      'No problem! The later slot is free.',
      'Certainly not, the meeting is off.',
    ])
      expect(humanText(text)).toBe(text);
  });

  test('an ordinary word with a comma is not an opener', () => {
    for (const text of [
      'Sure, I can move it to Friday.',
      'Of course, it rained.',
      'Great, the flight is on time.',
      'Certainly.',
      'Sure!',
    ])
      expect(humanText(text)).toBe(text);
  });

  test('stock closing lines at the very end go', () => {
    expect(humanText('The form is in your Files. I hope this helps!')).toBe(
      'The form is in your Files.',
    );
    expect(
      humanText(
        'The form is in your Files.\n\nLet me know if you have any other questions.\nHappy to help!',
      ),
    ).toBe('The form is in your Files.');
    expect(humanText("It's done. Is there anything else I can help you with?")).toBe("It's done.");
  });

  test('a closing line with something specific, or one with more after it, stays', () => {
    for (const text of [
      'Done. Let me know if you want me to book the 9:40 instead.',
      'I hope this helps you decide. The cheaper one ships Monday.',
      'Hope this helps! The cheaper one ships Monday.',
      '- Hope this helps',
    ])
      expect(humanText(text)).toBe(text);
  });

  test('a reply that is only a closing line is kept, never left empty', () => {
    expect(humanText('Happy to help!')).toBe('Happy to help!');
  });

  test('a short reply loses bold and heading marks and keeps the words', () => {
    expect(humanText('## Your flight\n\nIt leaves at **9:40** from **gate B12**.')).toBe(
      'Your flight\n\nIt leaves at 9:40 from gate B12.',
    );
  });

  test('a long reply keeps its formatting', () => {
    const long = `## Plan\n\n**Step one** is ${'quite a long sentence that goes on '.repeat(20)}done.`;
    expect(long.length).toBeGreaterThan(SHORT_REPLY_CHARACTERS);
    expect(humanText(long)).toBe(long);
  });

  test('an unmatched pair of stars is left alone', () => {
    expect(humanText('Use 2**3 for the cube.')).toBe('Use 2**3 for the cube.');
  });
});

describe('drafts written for someone else', () => {
  test('a draft keeps its greeting, closing lines and formatting, and loses its dashes', () => {
    const draft = `Hi Sam,\n\nThe invoice ${EM} sent on the 3rd ${EM} is still open.\n\n**Total:** $120\n\nLet me know if you have any questions.\n\nBest,\nAlex`;
    expect(humanText(draft, 'draft')).toBe(
      'Hi Sam,\n\nThe invoice, sent on the 3rd, is still open.\n\n**Total:** $120\n\nLet me know if you have any questions.\n\nBest,\nAlex',
    );
  });

  test('a draft does not drop a stock opener', () => {
    expect(humanText('Certainly! We can meet on Monday.', 'draft')).toBe(
      'Certainly! We can meet on Monday.',
    );
  });
});

describe('streaming', () => {
  const corpus = [
    `The plan ${EM} if it works ${EM} saves an hour. Certainly not more.`,
    `Certainly! It's booked ${EM} I sent the form at 2. I hope this helps!`,
    `Open 9${EN}5. See https://example.com/a${EM}b and \`x ${EM} y\` too ${EM} fine.`,
    `## Plan\n\nIt leaves at **9:40** ${EM} gate B12.\n\nLet me know if you have any questions.`,
    `\`\`\`\na ${EM} b\n\`\`\`\nThen ${EM} done. She wrote "a ${EM} b" -- twice.`,
    `> quoted ${EM} line\n- item ${EM} with a dash\n${EM} dialogue\nWe have three options ${EM} all bad.`,
    `Москва ${EM} столица. The fix ${EM} restart the router -- now.`,
    `Great question! The [link](https://x.dev/a${EM}b) works ${EM} mostly. Hope this helps!\n\n`,
    `I bought what you listed ${EM} milk, eggs and bread. The rate went up ${EM}`,
    `Two things${EM}the form and the fee. Pages 10${EM}12, ${EN} and Mon${EN}Fri.`,
  ];

  test('a dash split across pieces is read the same way', () => {
    expect(streamed(['We have three options ', EM, ' all bad.'])).toBe(
      'We have three options: all bad.',
    );
    expect(streamed(['The plan ', EM, ' if it works ', EM, ' saves an hour.'])).toBe(
      'The plan, if it works, saves an hour.',
    );
    expect(streamed(['Open 9', EN, '5.'])).toBe('Open 9-5.');
    expect(streamed(["It's cheaper -", '- but slower."'])).toBe(
      humanText(`It's cheaper -- but slower."`),
    );
  });

  test('every way of splitting the text shows what the whole text gives', () => {
    for (const text of corpus) {
      const whole = humanText(text);
      // One character at a time, and at every single cut.
      expect(streamed([...text])).toBe(whole);
      for (let cut = 1; cut < text.length; cut++)
        expect([cut, streamed([text.slice(0, cut), text.slice(cut)])]).toEqual([cut, whole]);
      const random = seeded(text.length);
      for (let round = 0; round < 50; round++)
        expect(streamed(randomSplit(text, random))).toBe(whole);
    }
  });

  test('drafts stream the same way', () => {
    for (const text of corpus) {
      const whole = humanText(text, 'draft');
      expect(streamed([...text], 'draft')).toBe(whole);
    }
  });

  test('a piece is shown as soon as nothing after it can change it', () => {
    const pass = new HumanText();
    expect(pass.push('The engineer is booked for Thursday')).toBe(
      'The engineer is booked for Thursday',
    );
    expect(pass.push(' at 9.')).toBe(' at 9.');
    expect(pass.push(' Hope')).toBe('');
    expect(pass.push(' you are well.')).toBe(' Hope you are well.');
    expect(pass.end()).toBe('');
  });

  test('a long reply with no special marks never waits for its end', () => {
    const pass = new HumanText();
    const words = 'The clinic called back and moved the visit to the afternoon slot '.repeat(10);
    expect(pass.push(words).length).toBeGreaterThan(words.length - 20);
  });
});

describe('every reply-mode output', () => {
  test('is unchanged by a second pass when it had only dashes to fix', () => {
    for (const text of [
      `The plan ${EM} if it works ${EM} saves an hour.`,
      `Open 9${EN}5 ${EM} weekdays only.`,
      `It's booked ${EM} I sent the form at 2.`,
    ]) {
      const once = humanText(text);
      expect(humanText(once)).toBe(once);
    }
  });
});

describe('the meaning stays', () => {
  test('a spaced range of days, times, prices or a subtraction takes a hyphen, not a comma', () => {
    expect(humanText(`Open Mon ${EN} Fri, closed weekends.`)).toBe(
      'Open Mon-Fri, closed weekends.',
    );
    expect(humanText(`Hours are 9am ${EN} 5pm.`)).toBe('Hours are 9am-5pm.');
    expect(humanText(`It costs $10 ${EN} $20.`)).toBe('It costs $10-$20.');
    expect(humanText(`Use n ${EN} 1 rows, so x ${EN} y is the gap.`)).toBe(
      'Use n-1 rows, so x-y is the gap.',
    );
    // A date and then an amount are two things.
    expect(humanText(`Due Oct 20 ${EM} $1,860.`)).toBe('Due Oct 20, $1,860.');
  });

  test('a warning in bold keeps its weight in a short reply', () => {
    for (const text of [
      '**Warning:** do not take this with alcohol.',
      'Please **do not** share the code.',
    ])
      expect(humanText(text)).toBe(text);
    expect(humanText('Your **plan** is ready.')).toBe('Your plan is ready.');
  });

  test('a mixed run of dashes is one mark, so no hyphens are left behind', () => {
    expect(humanText(`It works ${EN}-- mostly.`)).toBe('It works, mostly.');
  });
});

describe('a second pass changes nothing', () => {
  const sentences = [
    `il est parti ${EM} sans un mot`,
    `the plan is fine ${EM} we leave at noon`,
    `Gödel, Escher, Bach ${EN} three things`,
    `он сказал ${EM} нет`,
    `1990 ${EM}Gödel`,
    `**Warning** ${EM} it works`,
    `Mon ${EN} Fri`,
    `$10 ${EN} $20`,
    'see https://example.com/a—b',
    `"I ${EM} I can't"`,
  ];
  test('on mixed languages, marks and openers, and as it streams', () => {
    const random = seeded(507);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
    for (let round = 0; round < 400; round++) {
      let text = pick(['', 'Certainly! ', 'Great question! ', '## Plan\n', '- ']);
      for (let k = 0; k < 1 + Math.floor(random() * 8); k++)
        text += pick(sentences) + pick([' ', `. `, '\n', ` ${EM} `, '\n\n- ', '! ']);
      text += pick(['', '\n\nHope this helps!']);
      for (const mode of ['reply', 'draft'] as const) {
        const once = humanText(text, mode);
        expect([text, humanText(once, mode)]).toEqual([text, once]);
        expect([text, streamed(randomSplit(text, random), mode)]).toEqual([text, once]);
      }
    }
  });
});

describe('streaming keeps every character', () => {
  test('a rule line or a heading split before its end', () => {
    for (const text of ['- ---\nworks', '-  ---', `##   ${EN} noon`, '# ## Plan', '1.   item'])
      for (const mode of ['reply', 'draft'] as const)
        for (let cut = 1; cut < text.length; cut++)
          expect([text, cut, streamed([text.slice(0, cut), text.slice(cut)], mode)]).toEqual([
            text,
            cut,
            humanText(text, mode),
          ]);
  });
});
