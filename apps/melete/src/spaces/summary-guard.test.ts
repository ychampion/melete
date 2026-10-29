import { describe, expect, test } from 'bun:test';
import {
  detailsIn,
  EMPTY_ORIGINALS,
  keptLine,
  minimise,
  minimiseBody,
  placeholdersIn,
  readOriginals,
  scrub,
  scrubDeep,
  settled,
  stepRefusal,
} from './summary-guard.ts';

/** What the room's reads of one mailbox brought back, as the email connector's receipts carry it. */
const SEARCH = {
  messages: [
    {
      uid: 41,
      message_id: '<a41@okafor-clinic.example>',
      from: 'Dr. Wendell Okafor <frontdesk@okafor-clinic.example>',
      to: 'Odile Varga <odile@home.example>',
      subject: 'Your visit with Dr. Okafor on Tuesday, November 18 at 2:15 PM',
      date: '2026-11-03T15:00:00.000Z',
      text: 'Hi Odile, this confirms your follow-up with Dr. Wendell Okafor at Larkspur Family Medicine, 1200 Larch Street, Fairview, CA 94110. Bring your member ID BFC-221-40-1186. Questions? Call 555-0188.',
    },
    {
      uid: 42,
      message_id: '<a42@fairview-pharmacy.example>',
      from: 'Fairview Pharmacy <rx@fairview-pharmacy.example>',
      to: 'odile@home.example',
      subject: 'Refill reminder: lisinopril 10 mg due Nov 5 (no refills left)',
      text: 'Your prescription for lisinopril 10 mg (Rx 5512093) is due for refill on Nov 5. Prescriber: Wendell Okafor. There are no refills left, so we have asked your doctor’s office to renew it before you run out.',
    },
    {
      uid: 43,
      from: 'Brightfield Health Plans <notices@brightfield.example>',
      to: 'odile@home.example',
      subject: 'Your 2027 Annual Notice of Changes',
      text: 'Your plan, Brightfield Senior Choice (HMO), changes on January 1, 2027. Your monthly premium will go from $0 to $12.40 and specialist visits will need a referral first.',
    },
    {
      uid: 44,
      from: 'Ridgeline Power <billing@ridgeline-power.example>',
      to: 'odile@home.example',
      subject: 'Your statement is ready: $72.10 due November 12',
      text: 'Account 4410 2231 9087. Amount due $72.10 by November 12, 2026.',
      attachments: [{ id: 'att-1', name: 'Ridgeline statement November.pdf' }],
    },
  ],
};
const ROOM = { names: ['Odile', 'Theo'], addresses: ['odile@home.example', 'theo@home.example'] };
const originals = readOriginals([SEARCH], ROOM);

/** Everything that must never reach a summaries-only reader. */
const PRIVATE = [
  'Okafor',
  'Wendell',
  'frontdesk@okafor-clinic.example',
  'rx@fairview-pharmacy.example',
  'lisinopril',
  '5512093',
  'BFC-221-40-1186',
  '4410 2231 9087',
  '555-0188',
  'Brightfield',
  'Ridgeline',
  'Larkspur Family Medicine',
  '1200 Larch Street',
  'Annual Notice of Changes',
];
const leaks = (text: string, among = PRIVATE) =>
  among.filter((value) => text.toLowerCase().includes(value.toLowerCase()));
/**
 * What the model may not read. A subject with its details swapped out stays,
 * so the model knows what each message is; repeating it is scrubbed after.
 */
const UNSEEN = PRIVATE.filter((value) => value !== 'Annual Notice of Changes');

/** A model that tries to say everything it read. */
const LEAKY_ANSWER =
  'Mom has a follow-up with Dr. Wendell Okafor next Tuesday (Nov 18). Her lisinopril refill is due Nov 5, and since there are no refills left, Okafor’s office has to renew it. Her power bill of $72.10 is due November 12 (account 4410 2231 9087). She also got the 2027 Annual Notice of Changes from Brightfield. If anything is unclear, call 555-0188 or write to frontdesk@okafor-clinic.example.';

describe('what a summaries-only reader reads', () => {
  test('a model that names the doctor, the medicine, the subject and the numbers is scrubbed', () => {
    const { text, kept } = scrub(LEAKY_ANSWER, originals);
    expect(leaks(text)).toEqual([]);
    expect(kept).toBeGreaterThanOrEqual(8);
    expect(text).toBe(
      'Mom has a follow-up with the doctor next Tuesday (Nov 18). Her medicine refill is due Nov 5, and since there are no refills left, the doctor’s office has to renew it. Her power bill of $72.10 is due November 12 (account kept back). She also got the message from the health plan. If anything is unclear, call a phone number or write to an email address.',
    );
  });

  test('each spelling of a detail is caught: any case, a title, separators in a number', () => {
    for (const [said, expected] of [
      ['Ask DR. OKAFOR about it.', 'Ask the doctor about it.'],
      ['okafor called twice.', 'The doctor called twice.'],
      ['Wendell Okafor, MD wants a visit.', 'The doctor wants a visit.'],
      ['Account 4410-2231-9087 is hers.', 'Account kept back is hers.'],
      ['Member ID bfc-221-40-1186.', 'Member ID kept back.'],
      ['Her LISINOPRIL is low.', 'Her medicine is low.'],
      ['The Rx is 5512093.', 'The Rx is a prescription number.'],
      ['Call Dr. Okafor’s office.', 'Call the doctor’s office.'],
      ['Account 441022319087 is hers.', 'Account kept back is hers.'],
      ['Write to FrontDesk@Okafor-Clinic.example today.', 'Write to an email address today.'],
    ] as const)
      expect([said, scrub(said, originals).text]).toEqual([said, expected]);
  });

  test('quoting a message word for word is kept back, however it is punctuated', () => {
    const quoted =
      'The plan wrote: "monthly premium will go from $0 to $12.40 and specialist visits will need a referral first".';
    const { text, kept } = scrub(quoted, originals);
    expect(kept).toBe(1);
    expect(text).toContain('(details kept back)');
    expect(text).not.toContain('specialist visits will need a referral');
  });

  test('ordinary words, dates, amounts and the room’s own people survive', () => {
    for (const plain of [
      'Her power bill of $72.10 is due November 12, and the refill is due Nov 5.',
      'Please call the pharmacy this week; there is a grace period.',
      'Odile has a doctor’s appointment next Tuesday at 2:15 PM.',
      'Theo will pick up the medicine. Bill it to the card on file.',
      'Her statement is ready and a refill reminder came in.',
      'Her plan changes on January 1, 2027, and the premium goes up by $12.40.',
      'A COVID-19 booster is due in 2027.',
      'Call customer service or urgent care; primary care can help, and so can mental health support.',
    ]) {
      const { text, kept } = scrub(plain, originals);
      expect([plain, text, kept]).toEqual([plain, plain, 0]);
    }
  });

  test('nothing is changed where there are no originals', () => {
    expect(scrub(LEAKY_ANSWER, EMPTY_ORIGINALS)).toEqual({ text: LEAKY_ANSWER, kept: 0 });
  });

  test('the model’s own placeholders read as words, and are not counted as kept details', () => {
    expect(scrub('Remind [doctor 1] about [medicine 1].', originals)).toEqual({
      text: 'Remind the doctor about a medicine.',
      kept: 0,
    });
    expect(scrub('[pharmacy 1] says the refill is due.', originals).text).toBe(
      'The pharmacy says the refill is due.',
    );
  });

  test('a card or a board item is scrubbed field by field, its ids left alone', () => {
    const counter = { kept: 0 };
    const card = scrubDeep(
      {
        id: 'act_1:card',
        title: 'Call Dr. Okafor about lisinopril',
        facts: [{ label: 'Phone', value: '555-0188' }],
        source_connection: 'con_1',
      },
      originals,
      counter,
    );
    expect(card).toEqual({
      id: 'act_1:card',
      title: 'Call the doctor about a medicine',
      facts: [{ label: 'Phone', value: 'A phone number' }],
      source_connection: 'con_1',
    });
    expect(counter.kept).toBe(3);
  });

  test('the receipt says how many were kept out', () => {
    expect(keptLine(1, 'answer')).toBe('Kept 1 private detail out of this answer');
    expect(keptLine(2, 'request')).toBe('Kept 2 private details out of this request');
  });
});

describe('what the model reads for a summaries-only reader', () => {
  test('each detail goes as a stable placeholder by role; dates, amounts and kinds stay', () => {
    const text = minimise(JSON.stringify(SEARCH), originals);
    expect(leaks(text, UNSEEN)).toEqual([]);
    for (const kept of ['$72.10', 'November 12', 'Nov 5', 'refill', 'Tuesday', 'premium'])
      expect(text).toContain(kept);
    expect(text).toContain('[doctor 1]');
    expect(text).toContain('[medicine 1]');
    expect(text).toContain('[pharmacy 1]');
    // The same detail is the same placeholder wherever it appears.
    expect(minimise('Dr. Okafor and Wendell Okafor', originals)).toBe('[doctor 1] and [doctor 1]');
  });

  test('a whole request body is minimised, tool results and history alike', () => {
    const body = {
      model: 'x',
      messages: [
        { role: 'system', content: 'You help the room.' },
        { role: 'user', content: 'What does Mom need this week? Did Dr. Okafor write?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'email_search', arguments: '{"query":"from:okafor"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify(SEARCH) },
      ],
    };
    const sent = JSON.stringify(minimiseBody(body, 'chat/completions', originals));
    expect(leaks(sent, UNSEEN)).toEqual([]);
    expect(sent).toContain('"tool_call_id":"call_1"');
    expect(sent).toContain('email_search');
    // The tool result is still JSON the model can read.
    const tool =
      (JSON.parse(sent) as { messages: { content: string }[] }).messages[3]?.content ?? '';
    expect((JSON.parse(tool) as typeof SEARCH).messages[3]?.subject).toBe(
      'Your statement is ready: $72.10 due November 12',
    );
  });

  test('signed reasoning is left byte for byte', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Dr. Okafor wrote', signature: 'sig' }],
        },
      ],
    };
    expect(minimiseBody(body, 'messages', originals)).toEqual(body);
  });

  test('details of the room’s own people are not details of the originals', () => {
    expect(minimise('Odile Varga, odile@home.example', originals)).toBe(
      'Odile Varga, odile@home.example',
    );
  });
});

describe('what is a detail, and what is not', () => {
  /** Mail from services, whose display names are made of ordinary words. */
  const SERVICES = {
    messages: [
      {
        uid: 51,
        from: 'Google Calendar <calendar-notification@google.com>',
        to: 'odile@home.example',
        subject: 'Invitation: Eye exam @ Thu Nov 20, 2026 9am',
        text: 'You have been invited to an event.',
      },
      {
        uid: 52,
        from: 'Delta Air Lines <deltaairlines@t.delta.example>',
        to: 'odile@home.example',
        subject: 'Your trip confirmation',
        text: 'Your flight leaves on Friday.',
      },
      {
        uid: 53,
        from: 'Kaiser Permanente <member@kp.example>',
        to: 'odile@home.example',
        subject: 'A new test result',
        text: 'Sign in to read it.',
      },
    ],
  };
  const services = readOriginals([SERVICES], ROOM);

  test('a sender’s display name counts only whole, never word by word', () => {
    for (const said of [
      'I added the appointment to her calendar.',
      'Her flight lines up with the air fare.',
      'The kaiser roll was fine.',
    ])
      expect(scrub(said, services)).toEqual({ text: said, kept: 0 });
    expect(scrub('Delta Air Lines moved the flight.', services).kept).toBe(1);
    expect(scrub('Kaiser Permanente has a result.', services).kept).toBe(1);
  });

  test('a street counts on its own, in either spelling, as does part of a number', () => {
    for (const [said, expected] of [
      ['Billed to 1200 Larch Street.', 'Billed to an address.'],
      ['Billed to 1200 Larch St. today.', 'Billed to an address today.'],
      ['Your account is 4410 2231.', 'Your account is an account number.'],
      ['Your account is 44102231 for now.', 'Your account is an account number for now.'],
      ['The visit is at 2:15 PM on Tuesday.', 'The visit is at 2:15 PM on Tuesday.'],
    ] as const)
      expect([said, scrub(said, originals).text]).toEqual([said, expected]);
  });

  test('while an answer is written, words that could begin a detail wait for the rest', () => {
    for (const [sofar, shown] of [
      ['Your account is 4410 2231 ', 'Your account is '],
      ['Your account is 4410 22', 'Your account is '],
      ['Your account is 4410', 'Your account is '],
      ['She sees Wendell ', 'She sees '],
      ['Her bill is $72.10 and is due ', 'Her bill is $72.10 and is due '],
      ['Her bill is due Nov', 'Her bill is due '],
    ] as const)
      expect([sofar, settled(sofar, originals)]).toEqual([sofar, shown]);
  });
});

describe('what the agent may do for a summaries-only reader', () => {
  test('the request’s own instructions and tool definitions go as written', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'calendar_create',
          description:
            'Add an event to the calendar. Use it for anything Dr. Okafor’s office books.',
          parameters: {
            type: 'object',
            properties: { calendar: { type: 'string', enum: ['primary', 'Okafor'] } },
          },
        },
      },
    ];
    const body = {
      model: 'x',
      tools,
      messages: [
        { role: 'system', content: 'Use the calendar tool. Okafor is a name you may see.' },
        { role: 'user', content: 'Add the visit to my calendar.' },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(SEARCH) },
      ],
    };
    const sent = minimiseBody(body, 'chat/completions', originals) as typeof body;
    expect(sent.tools).toEqual(tools);
    expect(sent.messages[0]).toEqual(body.messages[0]);
    expect(sent.messages[1]).toEqual(body.messages[1]);
    expect(leaks(sent.messages[2]?.content ?? '', UNSEEN)).toEqual([]);
    // Responses and messages protocols keep their instructions too.
    expect(
      minimiseBody({ instructions: 'Okafor', input: 'Okafor' }, 'responses', originals),
    ).toEqual({ instructions: 'Okafor', input: '[doctor 1]' });
    expect(minimiseBody({ system: 'Okafor', messages: [] }, 'messages', originals)).toEqual({
      system: 'Okafor',
      messages: [],
    });
  });

  test('a step’s placeholders are found, and the refusal says who the step needs', () => {
    expect(placeholdersIn({ title: 'Visit with [doctor 1]', location: '[address 1]' })).toEqual([
      '[doctor 1]',
      '[address 1]',
    ]);
    expect(placeholdersIn({ title: 'Visit with the doctor', note: '[draft]' })).toEqual([]);
    expect(stepRefusal(['[doctor 1]'], 'Odile')).toBe(
      "Nothing was done. [doctor 1] stands for a detail of the room's mail and files that stays with Odile, who made this room, so it cannot go into this step. Say that this step needs Odile, and ask Odile to do it or to share what it needs.",
    );
    expect(stepRefusal([], 'Odile')).toBe(
      "Nothing was done. This step carries details of the room's mail and files that stay with Odile, who made this room, so they cannot go into it. Say that this step needs Odile, and ask Odile to do it or to share what it needs.",
    );
  });

  test('a placeholder is a placeholder in any case and however its words are joined', () => {
    expect(placeholdersIn({ a: '[Doctor 1]', b: '[PHONE_NUMBER 2]', c: '[id-number-3]' })).toEqual([
      '[Doctor 1]',
      '[PHONE_NUMBER 2]',
      '[id-number-3]',
    ]);
    expect(scrub('Ask [Doctor 1] to call [Phone_Number-2].', EMPTY_ORIGINALS).text).toBe(
      'Ask the doctor to call a phone number.',
    );
  });

  test('a detail written out in a step is found as the scrub finds it', () => {
    expect(
      detailsIn(
        { to: 'helper@else.example', body: ['Her doctor is Dr. Wendell Okafor, 555-0188.'] },
        originals,
      ),
    ).toBe(2);
    expect(detailsIn({ body: 'Her doctor’s visit is on Tuesday at 2:15 PM.' }, originals)).toBe(0);
  });
});
