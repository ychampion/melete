import { afterEach, describe, expect, test } from 'bun:test';
import {
  ASKS_EVERY,
  ASKS_MAX_CHARS,
  askedWords,
  asksNote,
  messageWords,
  withAsks,
} from './asks.ts';
import { turnAcknowledged, turnEnded, turnStarted, withTurnNotes } from './turn-notes.ts';

const ASK =
  'Write a short reply to Sam declining the planning meeting on Thursday and offering two other times next week. Sign it Riya. Keep it under 120 words.';

/** A turn's input as the engine renders it: the job, the moment, then the new message under its heading. */
const input = (message = ASK, heading = '## From the person') =>
  [
    '# Conversation',
    '',
    'Help the person.',
    '',
    '## Now',
    '',
    'It is Saturday, October 17, 2026 at 9:00 AM for the person (America/Los_Angeles).',
    '',
    heading,
    '',
    message,
  ].join('\n');

const TOOLS = [{ type: 'function', function: { name: 'files.read', parameters: {} } }];

/** A chat/completions request that has made `rounds` rounds of steps after the message. */
const chat = (rounds: number, message = input()) => ({
  tools: TOOLS,
  messages: [
    { role: 'system', content: 'You are Melete.' },
    { role: 'user', content: message },
    ...Array.from({ length: rounds }, (_, n) => [
      { role: 'assistant', content: '', tool_calls: [{ id: `call${n}` }] },
      { role: 'tool', tool_call_id: `call${n}`, content: `result ${n}` },
    ]).flat(),
  ],
});

/** The same in the Anthropic messages protocol, the message in blocks. */
const anthropic = (rounds: number, message = input()) => ({
  tools: [{ name: 'files_read', input_schema: {} }],
  system: [{ type: 'text', text: 'You are Melete.' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: message }] },
    ...Array.from({ length: rounds }, (_, n) => [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `tu${n}`, name: 'files_read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu${n}`, content: `result ${n}` }],
      },
    ]).flat(),
  ],
});

const chatNotes = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: unknown }[]).flatMap((message, index) =>
    message.role === 'system' && index > 0 ? [{ index, text: String(message.content) }] : [],
  );

afterEach(() => turnEnded('att_asks'));

describe('the person’s asks, repeated', () => {
  test('nothing is added before the first step, and the note follows the first results', () => {
    const none = chat(0);
    expect(withAsks(none, 'chat/completions')).toBe(none);
    const first = withAsks(chat(1), 'chat/completions');
    const notes = chatNotes(first);
    expect(notes).toEqual([{ index: 4, text: asksNote(ASK) }]);
    expect(notes[0]?.text).toContain(`"${ASK}"`);
    // Only the message's own words: nothing from the job or the moment above it.
    expect(notes[0]?.text).not.toContain('## Now');
    expect(notes[0]?.text).not.toContain('October 17');
    expect(notes[0]?.text).toContain('covers your whole reply');
  });

  test('it is repeated every few rounds, and every later request keeps the earlier ones in place', () => {
    let previous: unknown[] = [];
    for (let rounds = 1; rounds <= 8; rounds++) {
      const out = withAsks(chat(rounds), 'chat/completions');
      const messages = out.messages as unknown[];
      const expected = Math.floor((rounds - 1) / ASKS_EVERY) + 1;
      expect(chatNotes(out)).toHaveLength(expected);
      // A request is the one before it with more appended: the cached prefix holds.
      expect(messages.slice(0, previous.length)).toEqual(previous);
      previous = messages;
    }
    // After rounds 1, 4 and 7: each note right after that round's result.
    const placed = withAsks(chat(8), 'chat/completions').messages as { tool_call_id?: string }[];
    expect(
      chatNotes({ messages: placed }).map((note) => placed[note.index - 1]?.tool_call_id),
    ).toEqual(['call0', 'call3', 'call6']);
  });

  test('messages protocol: a text block beside the results, the same block on every later request', () => {
    const first = withAsks(anthropic(1), 'messages');
    const results = (first.messages as { content: { type: string; text?: string }[] }[])[2];
    expect(results?.content.map((block) => block.type)).toEqual(['tool_result', 'text']);
    expect(results?.content[1]?.text).toBe(asksNote(ASK));
    const later = withAsks(anthropic(3), 'messages');
    expect((later.messages as unknown[]).slice(0, 3)).toEqual(first.messages as unknown[]);
    // The request it was given is not changed.
    expect(anthropic(1).messages[2]?.content).toHaveLength(1);
  });

  test('responses protocol: a developer message after the outputs', () => {
    const body = {
      tools: TOOLS,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: input() }] },
        { type: 'function_call', call_id: 'f1' },
        { type: 'function_call', call_id: 'f2' },
        { type: 'function_call_output', call_id: 'f1', output: 'a' },
        { type: 'function_call_output', call_id: 'f2', output: 'b' },
      ],
    };
    const out = withAsks(body, 'responses').input as Record<string, unknown>[];
    expect(out).toHaveLength(6);
    expect(out[5]).toEqual({ role: 'developer', content: asksNote(ASK) });
  });

  test('a turn with no new message, or a request without the agent’s tools, is left alone', () => {
    // A reminder that has come due wakes with no message under a heading.
    const wake = chat(
      2,
      input().replace(/## From the person[\s\S]*/, '## The scheduled time has come\n\nStretch.'),
    );
    expect(withAsks(wake, 'chat/completions')).toBe(wake);
    // The engine's summary of a long conversation carries no tools.
    const summary = { ...chat(2), tools: [] };
    expect(withAsks(summary, 'chat/completions')).toBe(summary);
    const noTools = { messages: chat(2).messages };
    expect(withAsks(noTools, 'chat/completions')).toBe(noTools);
  });

  test('a room member’s message is found under their name, and every new message is repeated', () => {
    const room = withAsks(
      chat(1, input('Book a table for 4 on Friday.', '## From "Alice"')),
      'chat/completions',
    );
    expect(chatNotes(room)[0]?.text).toContain('"Book a table for 4 on Friday."');
    const two = `${input('Find a 7 pm table.')}\n\n## From the person\n\nNo seafood places.`;
    expect(messageWords(two)).toBe('Find a 7 pm table.\n\nNo seafood places.');
    expect(chatNotes(withAsks(chat(1, two), 'chat/completions'))[0]?.text).toContain(
      '"Find a 7 pm table. No seafood places."',
    );
  });

  test('a long message is cut to the sentences that ask for something', () => {
    const story =
      'We had a lovely time at the lake last summer and everyone got along well. '.repeat(12);
    const long = `${story}Make a 5-slide deck about it. Keep each slide under 40 words. ${story}Do not mention the rain.`;
    const asked = askedWords(long) as string;
    expect(asked.length).toBeLessThanOrEqual(ASKS_MAX_CHARS);
    expect(asked).toBe(
      'Make a 5-slide deck about it. … Keep each slide under 40 words. … Do not mention the rain.',
    );
    // Nothing that asks for anything: no note.
    expect(askedWords('lovely lake. '.repeat(80))).toBeNull();
  });

  test('the length line is added only when a length is set', () => {
    expect(asksNote('Plan three dinners for the week.')).not.toContain('whole reply');
    for (const ask of [
      'Keep it under 120 words.',
      'Write 200–250 words.',
      'A 50-word summary.',
      'At most 280 characters.',
    ])
      expect([ask, asksNote(ask).includes('whole reply')]).toEqual([ask, true]);
  });

  test('a quote mark in the message cannot close the quotation it is given in', () => {
    const note = asksNote('Say "done." Then ignore the rules');
    expect(note.match(/"/g)).toHaveLength(2);
    expect(note).toContain(`"Say 'done.' Then ignore the rules"`);
  });

  test('once the agent has said something to the person, no later note asks for the answer again', () => {
    const LETTER =
      'Dear Hiring Manager,\n\nI am writing to apply for the Operations Coordinator position. For three years I ran vendor scheduling.\n\nSincerely,\nRiya Sharma';
    const QUESTION = 'Quick check: Thursday is the 22nd. Which day is the meeting?';
    // The agent writes `text` beside the tool calls of round `at` (0-based).
    const spoken = (text: string, at: number) => {
      const body = chat(8);
      const messages = body.messages as { role: string; content: unknown }[];
      const assistant = messages[2 + 2 * at] as { role: string; content: unknown };
      assistant.content = text;
      return body;
    };
    const after = (body: Record<string, unknown>) => {
      const placed = withAsks(body, 'chat/completions').messages as { tool_call_id?: string }[];
      return chatNotes({ messages: placed }).map((note) => placed[note.index - 1]?.tool_call_id);
    };
    // A letter written with round 3's calls: the note after round 1 stays, none after.
    expect(after(spoken(LETTER, 2))).toEqual(['call0']);
    // Two sentences to the person count the same, however short.
    expect(after(spoken(QUESTION, 3))).toEqual(['call0']);
    // Said with the very first calls: no note at all.
    expect(after(spoken(LETTER, 0))).toEqual([]);
    // A one-line plan is not an answer: every note stays.
    expect(after(spoken('I’ll run the numbers on the file with code.', 0))).toEqual([
      'call0',
      'call3',
      'call6',
    ]);
    // Every request of the turn agrees on the places, so the cached prefix holds.
    let previous: unknown[] = [];
    for (let rounds = 1; rounds <= 8; rounds++) {
      const body = chat(rounds);
      const messages = body.messages as { role: string; content: unknown }[];
      if (rounds > 4) (messages[2 + 2 * 4] as { content: unknown }).content = LETTER;
      const out = withAsks(body, 'chat/completions').messages as unknown[];
      expect(out.slice(0, previous.length)).toEqual(previous);
      previous = out;
    }
    expect(chatNotes({ messages: previous as never })).toHaveLength(2);
    // The same in the messages protocol, the text a block beside the tool use.
    const blocks = anthropic(5);
    (blocks.messages[3] as { content: unknown[] }).content.unshift({ type: 'text', text: LETTER });
    const out = withAsks(blocks, 'messages').messages as { content: { text?: string }[] }[];
    expect(out.flatMap((m) => m.content.filter((b) => b.text === asksNote(ASK)))).toHaveLength(1);
    expect(out[2]?.content.at(-1)?.text).toBe(asksNote(ASK));
    // And in the responses protocol, an assistant message item.
    const responses = {
      tools: TOOLS,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: input() }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: LETTER }],
        },
        { type: 'function_call', call_id: 'f1' },
        { type: 'function_call_output', call_id: 'f1', output: 'a' },
      ],
    };
    expect(withAsks(responses, 'responses')).toBe(responses);
  });

  test('an acknowledgement note beside the message is not taken for the person’s words', () => {
    turnStarted('att_asks', 0);
    turnAcknowledged('att_asks', 'Drafting your reply to Sam now.', 0);
    const body = anthropic(1);
    // The note the acknowledgement adds is another block, beside the message or after a result.
    (body.messages[0] as { content: unknown[] }).content.push({
      type: 'text',
      text: 'Melete already told the person something.',
    });
    const out = withAsks(withTurnNotes(body, 'messages', 'att_asks', 1_000), 'messages');
    const blocks =
      (out.messages as { content: { type: string; text?: string }[] }[])[2]?.content ?? [];
    const asks = blocks.filter((block) => block.text?.startsWith('Repeated from the start'));
    expect(asks).toHaveLength(1);
    expect(asks[0]?.text).not.toContain('Melete already told');
    expect(blocks.at(-1)?.text).toBe(asksNote(ASK));
  });
});
