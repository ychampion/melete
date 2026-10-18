import { describe, expect, test } from 'bun:test';
import { markAnthropicCache } from './caching.ts';
import {
  LONG_TURN_NOTE,
  LONG_TURN_ROUNDS,
  PROGRESS_NOTE,
  PROGRESS_ROUNDS,
  withLongTurnNote,
} from './long-turn.ts';
import { PROGRESS_AFTER_MS, turnEnded, turnStarted, withTurnNotes } from './turn-notes.ts';

const tool = (name: string) => ({ type: 'function', function: { name, parameters: {} } });
const round = (name = 'web.fetch') => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c', content: '{"status":"succeeded"}' },
];
const request = (
  rounds: number,
  tools = [tool('run.start'), tool('web.fetch')],
  extra: unknown[] = [],
) => ({
  model: 'm',
  tools,
  messages: [
    { role: 'system', content: 'You are Melete.' },
    { role: 'user', content: 'Research robot vacuums in the background.' },
    ...Array.from({ length: rounds }, () => round()).flat(),
    ...extra,
  ],
});
const noted = (body: Record<string, unknown>) =>
  (body.messages as { content?: unknown }[]).at(-1)?.content === LONG_TURN_NOTE;

describe('a conversation turn that runs long', () => {
  test('is pointed at background work once it passes the round limit', () => {
    expect(noted(withLongTurnNote(request(LONG_TURN_ROUNDS - 1), 'chat/completions'))).toBe(false);
    const long = withLongTurnNote(request(LONG_TURN_ROUNDS), 'chat/completions');
    expect(noted(long)).toBe(true);
    // Only the outgoing request carries it; the body it was given is unchanged.
    const body = request(LONG_TURN_ROUNDS);
    withLongTurnNote(body, 'chat/completions');
    expect(noted(body)).toBe(false);
  });

  test('counts only the current turn, from the latest message', () => {
    const earlier = request(LONG_TURN_ROUNDS, undefined, [
      { role: 'assistant', content: 'Here is what I found.' },
      { role: 'user', content: 'Thanks, and the price?' },
      ...round(),
    ]);
    expect(noted(withLongTurnNote(earlier, 'chat/completions'))).toBe(false);
  });

  test('is left alone where background work is not offered or has started', () => {
    expect(
      noted(
        withLongTurnNote(request(LONG_TURN_ROUNDS + 2, [tool('web.fetch')]), 'chat/completions'),
      ),
    ).toBe(false);
    const started = request(LONG_TURN_ROUNDS + 2, undefined, round('run.start'));
    expect(noted(withLongTurnNote(started, 'chat/completions'))).toBe(false);
  });
});

describe('a conversation turn that goes quiet', () => {
  const chat = [tool('say'), tool('web.fetch')];
  const last = (body: Record<string, unknown>) =>
    (body.messages as { content?: unknown }[]).at(-1)?.content;
  const nudged = (body: Record<string, unknown>) => last(body) === PROGRESS_NOTE;

  test('is asked for one specific update after several silent rounds', () => {
    expect(PROGRESS_ROUNDS).toBe(5);
    expect(nudged(withLongTurnNote(request(PROGRESS_ROUNDS - 1, chat), 'chat/completions'))).toBe(
      false,
    );
    expect(nudged(withLongTurnNote(request(PROGRESS_ROUNDS, chat), 'chat/completions'))).toBe(true);
    // It stays asked until it speaks: the notes are never recorded, so one at most is in view.
    const later = withLongTurnNote(request(PROGRESS_ROUNDS + 3, chat), 'chat/completions');
    expect(nudged(later)).toBe(true);
    expect(
      (later.messages as { content?: unknown }[]).filter((m) => m.content === PROGRESS_NOTE),
    ).toHaveLength(1);
  });

  test('is not asked after it tells the person something, in words or with say', () => {
    const spoken = (message: Record<string, unknown>) =>
      request(2, chat, [message, ...Array.from({ length: 3 }, () => round()).flat()]);
    const words = {
      role: 'assistant',
      content: 'Google Flights shows three non-stops so far.',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'web.fetch', arguments: '{}' } }],
    };
    expect(nudged(withLongTurnNote(spoken(words), 'chat/completions'))).toBe(false);
    const parts = { ...words, content: [{ type: 'text', text: 'Checking the fares now.' }] };
    expect(nudged(withLongTurnNote(spoken(parts), 'chat/completions'))).toBe(false);
    const said = request(2, chat, [
      ...round('say'),
      ...Array.from({ length: 3 }, () => round()).flat(),
    ]);
    expect(nudged(withLongTurnNote(said, 'chat/completions'))).toBe(false);
    // Blank words are not an update.
    const blank = { ...words, content: '   ' };
    expect(nudged(withLongTurnNote(spoken(blank), 'chat/completions'))).toBe(true);
  });

  test('never doubles up with the closing note, and is not given where say is not offered', () => {
    const both = withLongTurnNote(
      request(LONG_TURN_ROUNDS, [tool('run.start'), ...chat]),
      'chat/completions',
    );
    expect(last(both)).toBe(LONG_TURN_NOTE);
    expect(
      (both.messages as { content?: unknown }[]).filter((m) => m.content === PROGRESS_NOTE),
    ).toHaveLength(0);
    // A helper or background work is offered no say, and is never asked.
    expect(
      nudged(
        withLongTurnNote(request(PROGRESS_ROUNDS + 3, [tool('web.fetch')]), 'chat/completions'),
      ),
    ).toBe(false);
  });
});

// Anthropic's Messages protocol: calls are tool_use blocks, and their results
// come back as tool_result blocks in the next user message.
type Block = {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  cache_control?: unknown;
};
type Message = { role: string; content: string | Block[] };
const claudeTool = (name: string) => ({
  name,
  description: name,
  input_schema: { type: 'object' },
});
let used = 0;
const step = (name = 'web.fetch', words?: string) => {
  const id = `toolu_${++used}`;
  return [
    {
      role: 'assistant',
      content: [
        ...(words ? [{ type: 'text', text: words }] : []),
        { type: 'tool_use', id, name, input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: '{"status":"succeeded"}' }],
    },
  ];
};
const claude = (
  rounds: number,
  tools = [claudeTool('run.start'), claudeTool('web.fetch')],
  extra: unknown[] = [],
): Record<string, unknown> => ({
  model: 'claude',
  system: [{ type: 'text', text: 'You are Melete.', cache_control: { type: 'ephemeral' } }],
  tools,
  messages: [
    { role: 'user', content: 'Research robot vacuums in the background.' },
    ...Array.from({ length: rounds }, () => step()).flat(),
    ...extra,
  ],
});
const messagesOf = (body: Record<string, unknown>) => body.messages as Message[];
const blocksOf = (message: Message | undefined) =>
  Array.isArray(message?.content) ? message.content : [];
/** How many times the note appears anywhere in the request. */
const times = (body: Record<string, unknown>, note: string) =>
  messagesOf(body)
    .flatMap(blocksOf)
    .filter((block) => block.type === 'text' && block.text === note).length;
const closing = (body: Record<string, unknown>) => blocksOf(messagesOf(body).at(-1)).at(-1)?.text;
/** What Anthropic checks of a conversation that a note could break. */
const wellFormed = (body: Record<string, unknown>) => {
  const messages = messagesOf(body);
  messages.forEach((message, index) => {
    expect(['user', 'assistant']).toContain(message.role);
    if (index > 0) expect(message.role).not.toBe(messages[index - 1]?.role);
    const uses = blocksOf(message)
      .filter((block) => block.type === 'tool_use')
      .map((block) => block.id);
    if (message.role !== 'assistant' || !uses.length) return;
    // Each call's result opens the next message, before any text.
    expect(
      blocksOf(messages[index + 1])
        .slice(0, uses.length)
        .map((block) => [block.type, block.tool_use_id]),
    ).toEqual(uses.map((id) => ['tool_result', id]));
  });
};

describe('a long or quiet turn over Anthropic messages', () => {
  test('is pointed at background work with a text block after the last tool results', () => {
    expect(times(withLongTurnNote(claude(LONG_TURN_ROUNDS - 1), 'messages'), LONG_TURN_NOTE)).toBe(
      0,
    );
    const body = claude(LONG_TURN_ROUNDS);
    const before = JSON.stringify(body);
    const long = withLongTurnNote(body, 'messages');
    expect(closing(long)).toBe(LONG_TURN_NOTE);
    expect(times(long, LONG_TURN_NOTE)).toBe(1);
    wellFormed(long);
    // Everything before the note is as it was, so the cached prefix still matches.
    expect(long.system).toBe(body.system);
    expect(long.tools).toBe(body.tools);
    expect(JSON.stringify(messagesOf(long).slice(0, -1))).toBe(
      JSON.stringify(messagesOf(body).slice(0, -1)),
    );
    expect(blocksOf(messagesOf(long).at(-1)).slice(0, -1)).toEqual(
      blocksOf(messagesOf(body).at(-1)),
    );
    // Only the outgoing request carries it.
    expect(JSON.stringify(body)).toBe(before);
  });

  test('counts the turn from the person, and a tool result is not the person', () => {
    const earlier = claude(LONG_TURN_ROUNDS, undefined, [
      { role: 'assistant', content: [{ type: 'text', text: 'Here is what I found.' }] },
      { role: 'user', content: 'Thanks, and the price?' },
      ...step(),
    ]);
    expect(times(withLongTurnNote(earlier, 'messages'), LONG_TURN_NOTE)).toBe(0);
    // A tool result with a note of the service's beside it is still a tool result.
    const body = claude(LONG_TURN_ROUNDS);
    const results = messagesOf(body)[2] as { content: Block[] };
    results.content = [
      ...results.content,
      { type: 'text', text: 'Melete already told the person.' },
    ];
    expect(closing(withLongTurnNote(body, 'messages'))).toBe(LONG_TURN_NOTE);
  });

  test('is left alone where background work is not offered or has started', () => {
    const plain = claude(LONG_TURN_ROUNDS + 2, [claudeTool('web.fetch')]);
    expect(withLongTurnNote(plain, 'messages')).toBe(plain);
    const started = claude(LONG_TURN_ROUNDS + 2, undefined, step('run.start'));
    expect(withLongTurnNote(started, 'messages')).toBe(started);
  });

  test('is asked for an update after quiet rounds, and not once it has spoken', () => {
    const chat = [claudeTool('say'), claudeTool('web.fetch')];
    expect(
      times(withLongTurnNote(claude(PROGRESS_ROUNDS - 1, chat), 'messages'), PROGRESS_NOTE),
    ).toBe(0);
    const quiet = withLongTurnNote(claude(PROGRESS_ROUNDS, chat), 'messages');
    expect(closing(quiet)).toBe(PROGRESS_NOTE);
    expect(times(quiet, PROGRESS_NOTE)).toBe(1);
    wellFormed(quiet);
    const spoken = claude(2, chat, [
      ...step('web.fetch', 'Three non-stops so far.'),
      ...Array.from({ length: 3 }, () => step()).flat(),
    ]);
    expect(times(withLongTurnNote(spoken, 'messages'), PROGRESS_NOTE)).toBe(0);
    const said = claude(2, chat, [
      ...step('say'),
      ...Array.from({ length: 3 }, () => step()).flat(),
    ]);
    expect(times(withLongTurnNote(said, 'messages'), PROGRESS_NOTE)).toBe(0);
    // The closing note is the one given when both are due.
    const both = withLongTurnNote(
      claude(LONG_TURN_ROUNDS, [claudeTool('run.start'), ...chat]),
      'messages',
    );
    expect(closing(both)).toBe(LONG_TURN_NOTE);
    expect(times(both, PROGRESS_NOTE)).toBe(0);
  });

  test('a later round carries the note once, at its own end', () => {
    // The engine never records the note, so the next request arrives without it.
    const later = withLongTurnNote(claude(LONG_TURN_ROUNDS + 1), 'messages');
    expect(closing(later)).toBe(LONG_TURN_NOTE);
    expect(times(later, LONG_TURN_NOTE)).toBe(1);
    wellFormed(later);
  });

  test("keeps the gateway's own cache breakpoint on the tool result, not the note", () => {
    const body = { ...claude(LONG_TURN_ROUNDS), system: 'You are Melete.' };
    const long = withLongTurnNote(body, 'messages');
    expect(closing(long)).toBe(LONG_TURN_NOTE);
    expect(markAnthropicCache(long)).toBe(3);
    const [result, note] = blocksOf(messagesOf(long).at(-1));
    expect(result?.type).toBe('tool_result');
    expect(result?.cache_control).toEqual({ type: 'ephemeral' });
    expect(note?.cache_control).toBeUndefined();
  });
});

// The Responses protocol: calls and their outputs are items of their own.
const fnTool = (name: string) => ({ type: 'function', name, parameters: {} });
const calls = (names: string[], words?: string) => {
  const ids = names.map(() => `call_${++used}`);
  return [
    ...(words
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: words }] }]
      : []),
    ...names.map((name, at) => ({
      type: 'function_call',
      call_id: ids[at],
      name,
      arguments: '{}',
    })),
    ...ids.map((id) => ({
      type: 'function_call_output',
      call_id: id,
      output: '{"status":"succeeded"}',
    })),
  ];
};
const openai = (
  rounds: number,
  tools = [fnTool('run.start'), fnTool('web.fetch')],
  extra: unknown[] = [],
  together = 1,
): Record<string, unknown> => ({
  model: 'gpt',
  tools,
  input: [
    { role: 'user', content: 'Research robot vacuums in the background.' },
    ...Array.from({ length: rounds }, () => calls(Array(together).fill('web.fetch'))).flat(),
    ...extra,
  ],
});
const lastItem = (body: Record<string, unknown>) =>
  (body.input as Record<string, unknown>[]).at(-1);

describe('a long or quiet turn over the Responses protocol', () => {
  test('is pointed at background work with a developer message at the end', () => {
    expect(lastItem(withLongTurnNote(openai(LONG_TURN_ROUNDS - 1), 'responses'))?.content).not.toBe(
      LONG_TURN_NOTE,
    );
    const body = openai(LONG_TURN_ROUNDS);
    const long = withLongTurnNote(body, 'responses');
    expect(lastItem(long)).toEqual({ role: 'developer', content: LONG_TURN_NOTE });
    expect((long.input as unknown[]).slice(0, -1)).toEqual(body.input as unknown[]);
    expect((body.input as unknown[]).length).toBe((long.input as unknown[]).length - 1);
    // Calls made together are one round.
    const together = openai(LONG_TURN_ROUNDS - 1, undefined, [], 2);
    expect(withLongTurnNote(together, 'responses')).toBe(together);
    const started = openai(LONG_TURN_ROUNDS + 2, undefined, calls(['run.start']));
    expect(withLongTurnNote(started, 'responses')).toBe(started);
  });

  test('is asked for an update after quiet rounds, and not once it has spoken', () => {
    const chat = [fnTool('say'), fnTool('web.fetch')];
    expect(lastItem(withLongTurnNote(openai(PROGRESS_ROUNDS, chat), 'responses'))).toEqual({
      role: 'developer',
      content: PROGRESS_NOTE,
    });
    const spoken = openai(2, chat, [
      ...calls(['web.fetch'], 'Three non-stops so far.'),
      ...Array.from({ length: 3 }, () => calls(['web.fetch'])).flat(),
    ]);
    expect(withLongTurnNote(spoken, 'responses')).toBe(spoken);
  });
});

describe("beside the service's own ask for a line after a quiet stretch", () => {
  // `turn-notes.ts` asks for a line once a turn has gone quiet for a while;
  // when that ask follows the same step this note would, one ask is enough.
  const chat = (rounds: number) => ({
    model: 'm',
    tools: [tool('say'), tool('web.fetch')],
    messages: [
      { role: 'user', content: 'Compare three flights.' },
      ...Array.from({ length: rounds }, () => {
        const id = `c${++used}`;
        return [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id, type: 'function', function: { name: 'web.fetch', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: id, content: '{"status":"succeeded"}' },
        ];
      }).flat(),
    ],
  });
  const bodies = {
    'chat/completions': () => chat(PROGRESS_ROUNDS),
    messages: () => claude(PROGRESS_ROUNDS, [claudeTool('say'), claudeTool('web.fetch')]),
    responses: () => openai(PROGRESS_ROUNDS, [fnTool('say'), fnTool('web.fetch')]),
  } as const;
  const asks = (body: Record<string, unknown>) => {
    const text = JSON.stringify(body);
    return {
      timed: text.split('seconds have passed with nothing said').length - 1,
      rounds: text.split(PROGRESS_NOTE).length - 1,
    };
  };
  for (const [protocol, body] of Object.entries(bodies))
    test(`over ${protocol}, a request carries one ask, not two`, () => {
      const attempt = `att_quiet_${protocol}`;
      turnStarted(attempt, Date.now() - PROGRESS_AFTER_MS - 1_000);
      const both = withLongTurnNote(
        withTurnNotes(body(), protocol as keyof typeof bodies, attempt),
        protocol as keyof typeof bodies,
      );
      expect(asks(both)).toEqual({ timed: 1, rounds: 0 });
      if (protocol === 'messages') wellFormed(both);
      // A later request that ends on a new step, still quiet, gets this note.
      const next = withLongTurnNote(
        withTurnNotes(body(), protocol as keyof typeof bodies, attempt),
        protocol as keyof typeof bodies,
      );
      expect(asks(next).rounds).toBe(1);
      turnEnded(attempt);
      // Without the service's ask, the note is added as before.
      expect(asks(withLongTurnNote(body(), protocol as keyof typeof bodies)).rounds).toBe(1);
    });
});
