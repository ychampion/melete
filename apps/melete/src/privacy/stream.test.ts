import { describe, expect, test } from 'bun:test';
import type { Protocol } from './redact.ts';
import { partialStart, Rehydrator } from './stream.ts';
import { Vault } from './vault.ts';

const vault = new Vault();
const ACCOUNT = vault.assign('account', '000123456789');
const EMAIL = vault.assign('email', 'sam.rivera@example.org');
// A value that needs escaping inside argument JSON.
const NAME = vault.assign('name', 'Ann "Nan" O\'Neil \\ Jr');
const values: Record<string, string> = {
  [ACCOUNT]: '000123456789',
  [EMAIL]: 'sam.rivera@example.org',
  [NAME]: 'Ann "Nan" O\'Neil \\ Jr',
};

const put = (text: string) =>
  text.replace(/⟦[A-Z_]+_\d+⟧/g, (placeholder) => values[placeholder] ?? placeholder);

/** A seeded generator, so a failing split can be replayed. */
function random(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % limit;
  };
}

/** Cut a text into pieces at random places, often inside placeholders. */
function pieces(text: string, next: (limit: number) => number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest) {
    const size = 1 + next(Math.min(rest.length, 9));
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return out;
}

const frame = (event: Record<string, unknown>, name?: string) =>
  `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(event)}\n\n`;

/** Build a stream whose text and argument deltas are cut at random. */
function stream(protocol: Protocol, text: string, args: string, next: (limit: number) => number) {
  const events: string[] = [];
  if (protocol === 'chat/completions') {
    for (const piece of pieces(text, next))
      events.push(frame({ id: 'c1', choices: [{ index: 0, delta: { content: piece } }] }));
    events.push(
      frame({
        id: 'c1',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'pay', arguments: '' },
                },
              ],
            },
          },
        ],
      }),
    );
    for (const piece of pieces(args, next))
      events.push(
        frame({
          id: 'c1',
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } },
          ],
        }),
      );
    events.push(
      frame({
        id: 'c1',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    );
    events.push('data: [DONE]\n\n');
  } else if (protocol === 'responses') {
    for (const piece of pieces(text, next))
      events.push(
        frame(
          {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: piece,
          },
          'response.output_text.delta',
        ),
      );
    for (const piece of pieces(args, next))
      events.push(
        frame(
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 1,
            delta: piece,
          },
          'response.function_call_arguments.delta',
        ),
      );
    events.push(
      frame(
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_1',
          output_index: 1,
          arguments: args,
        },
        'response.function_call_arguments.done',
      ),
    );
    events.push(
      frame(
        {
          type: 'response.completed',
          response: {
            output: [
              { type: 'message', content: [{ type: 'output_text', text }] },
              { type: 'function_call', arguments: args },
            ],
          },
        },
        'response.completed',
      ),
    );
  } else {
    events.push(
      frame(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        'content_block_start',
      ),
    );
    for (const piece of pieces(text, next))
      events.push(
        frame(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
          'content_block_delta',
        ),
      );
    events.push(frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop'));
    events.push(
      frame(
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'pay', input: {} },
        },
        'content_block_start',
      ),
    );
    for (const piece of pieces(args, next))
      events.push(
        frame(
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: piece },
          },
          'content_block_delta',
        ),
      );
    events.push(frame({ type: 'content_block_stop', index: 1 }, 'content_block_stop'));
    events.push(frame({ type: 'message_stop' }, 'message_stop'));
  }
  return events.join('');
}

/** What a client reassembles: the answer text and the argument JSON. */
function read(protocol: Protocol, output: string) {
  let text = '';
  let args = '';
  for (const block of output.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    if (!data || data === '[DONE]') continue;
    const event = JSON.parse(data);
    if (protocol === 'chat/completions') {
      const delta = event.choices?.[0]?.delta ?? {};
      text += delta.content ?? '';
      args += delta.tool_calls?.[0]?.function?.arguments ?? '';
    } else if (protocol === 'responses') {
      if (event.type === 'response.output_text.delta') text += event.delta;
      if (event.type === 'response.function_call_arguments.delta') args += event.delta;
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') text += event.delta.text;
      else args += event.delta.partial_json;
    }
  }
  return { text, args };
}

describe('placeholders split anywhere come back whole', () => {
  const text = `Paying ${ACCOUNT} now, and I will email ${EMAIL} for ${NAME}. Unknown ⟦ACCOUNT_9⟧ stays.`;
  const args = JSON.stringify({ to: ACCOUNT, memo: `for ${NAME}`, cc: [EMAIL] });
  for (const protocol of ['chat/completions', 'responses', 'messages'] as const)
    test(`${protocol}: 300 random cuts of events and bytes`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const next = random(seed);
        const source = stream(protocol, text, args, next);
        const rehydrator = new Rehydrator(vault, protocol);
        let output = '';
        // The network cuts the bytes too, independently of the event boundaries.
        for (const chunk of pieces(source, next)) output += rehydrator.push(chunk);
        output += rehydrator.end();
        const result = read(protocol, output);
        expect([seed, result.text]).toEqual([seed, put(text)]);
        expect([seed, JSON.parse(result.args)]).toEqual([
          seed,
          {
            to: '000123456789',
            memo: 'for Ann "Nan" O\'Neil \\ Jr',
            cc: ['sam.rivera@example.org'],
          },
        ]);
        expect(output).not.toContain(ACCOUNT);
        expect(output).not.toContain(EMAIL);
      }
    });

  test('complete events elsewhere in the stream are rehydrated too', () => {
    const rehydrator = new Rehydrator(vault, 'responses');
    const source = stream('responses', `to ${ACCOUNT}`, JSON.stringify({ to: ACCOUNT }), random(7));
    const output = rehydrator.push(source) + rehydrator.end();
    const completed = output
      .split('\n\n')
      .find((block) => block.includes('response.completed'))
      ?.split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    const parsed = JSON.parse(completed ?? '{}');
    expect(parsed.response.output[0].content[0].text).toBe('to 000123456789');
    expect(JSON.parse(parsed.response.output[1].arguments)).toEqual({ to: '000123456789' });
  });

  test('an argument placeholder the model escaped as JSON is rehydrated as JSON', () => {
    const rehydrator = new Rehydrator(vault, 'chat/completions');
    const escaped = '{"to":"\\u27e6ACCOUNT_1\\u27e7","who":"\\u27E6NAME_1\\u27E7"}';
    const events = [escaped.slice(0, 11), escaped.slice(11, 19), escaped.slice(19)].map((piece) =>
      frame({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } },
        ],
      }),
    );
    const output = rehydrator.push(events.join('')) + rehydrator.end();
    expect(JSON.parse(read('chat/completions', output).args)).toEqual({
      to: '000123456789',
      who: 'Ann "Nan" O\'Neil \\ Jr',
    });
  });

  test('a partial placeholder with nothing after it is released as written', () => {
    const rehydrator = new Rehydrator(vault, 'chat/completions');
    const output =
      rehydrator.push(frame({ choices: [{ index: 0, delta: { content: 'ends with ⟦ACC' } }] })) +
      rehydrator.push(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })) +
      rehydrator.end();
    expect(read('chat/completions', output).text).toBe('ends with ⟦ACC');
  });

  test('events without anything placeholder-like pass through byte for byte', () => {
    const rehydrator = new Rehydrator(vault, 'chat/completions');
    const source =
      ': keepalive\n\ndata: {"choices":[{"index":0,"delta":{"content":"plain"}}]}\r\n\r\ndata: [DONE]\n\n';
    expect(rehydrator.push(source) + rehydrator.end()).toBe(source);
  });

  test('a non-streamed reply is rehydrated as a whole', () => {
    const rehydrator = new Rehydrator(vault, 'chat/completions');
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: `sent to ${EMAIL}`,
            tool_calls: [{ function: { name: 'pay', arguments: JSON.stringify({ who: NAME }) } }],
          },
        },
      ],
    });
    const parsed = JSON.parse(rehydrator.json(body));
    expect(parsed.choices[0].message.content).toBe('sent to sam.rivera@example.org');
    expect(JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      who: 'Ann "Nan" O\'Neil \\ Jr',
    });
  });
});

describe('partialStart', () => {
  test('finds the earliest possible start of a placeholder still arriving', () => {
    expect(partialStart('abc ⟦ACC', false)).toBe(4);
    expect(partialStart('abc ⟦', false)).toBe(4);
    expect(partialStart('abc ⟦ACCOUNT_1⟧ done', false)).toBe(-1);
    expect(partialStart('abc \\u27e6ACCOUNT_1\\u27', true)).toBe(4);
    expect(partialStart('abc \\u2', true)).toBe(4);
    // Outside argument JSON a backslash is just a character.
    expect(partialStart('abc \\u2', false)).toBe(-1);
    expect(partialStart('⟦lower', false)).toBe(-1);
  });
});
