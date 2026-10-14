import { describe, expect, test } from 'bun:test';
import { encodeToolNames, ToolNameStream, toolNameDecoder } from './tool-names.ts';

const WIRE = /^[a-zA-Z0-9_-]{1,128}$/;

function wireNames(codec: ReturnType<typeof encodeToolNames>): string[] {
  if (!codec) throw new Error('expected the tools to be renamed');
  return (codec.body.tools as { name: string }[]).map((tool) => tool.name);
}

const request = () => ({
  model: 'claude-sonnet-5-5',
  tools: [
    { name: 'web.search', input_schema: { type: 'object' } },
    { name: 'terminal', input_schema: { type: 'object' } },
    { type: 'web_search_20260209', name: 'web_search' },
  ],
  tool_choice: { type: 'tool', name: 'web.search' },
  messages: [
    { role: 'user', content: 'look it up' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Calling web.search now.' },
        { type: 'tool_use', id: 'toolu_1', name: 'web.search', input: { q: 'x' } },
        { type: 'tool_use', id: 'toolu_2', name: 'run.finish', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' }],
    },
  ],
});

describe('tool names on the Messages API', () => {
  test('every name the API refuses is renamed, everywhere it appears, and nothing else', () => {
    const original = request();
    const snapshot = structuredClone(original);
    const codec = encodeToolNames(original);
    expect(codec).not.toBeNull();
    const body = codec?.body as ReturnType<typeof request>;
    expect(body.tools.map((tool) => tool.name)).toEqual(['web__search', 'terminal', 'web_search']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'web__search' });
    const calls = body.messages[1]?.content as { type: string; name?: string; text?: string }[];
    expect(calls.map((block) => block.name)).toEqual([undefined, 'web__search', 'run__finish']);
    // The model's own words and a server tool keep theirs.
    expect(calls[0]?.text).toBe('Calling web.search now.');
    expect(body.messages[2]).toEqual(original.messages[2]);
    // The engine's body is not touched, so a retry starts from the same request.
    expect(original).toEqual(snapshot);
    expect([...(codec?.names ?? [])]).toEqual([
      ['web__search', 'web.search'],
      ['run__finish', 'run.finish'],
    ]);
  });

  test('a request whose names are all accepted is left alone', () => {
    expect(
      encodeToolNames({
        tools: [{ name: 'terminal' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toBeNull();
    expect(encodeToolNames({ messages: [] })).toBeNull();
  });

  test('a wire name never takes the name of another tool, and the same names map the same way', () => {
    const body = {
      tools: [{ name: 'a.b' }, { name: 'a__b' }, { name: 'a:b' }, { name: 'a_b' }, { name: 'a/b' }],
    };
    const codec = encodeToolNames(body);
    const names = wireNames(codec);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(WIRE);
    expect(names[1]).toBe('a__b');
    expect(names[3]).toBe('a_b');
    // Byte-stable from turn to turn, so the provider's prompt cache still matches.
    expect(JSON.stringify(encodeToolNames(body)?.body)).toBe(JSON.stringify(codec?.body));
  });

  test('a name past the length limit is shortened to a distinct wire name', () => {
    const long = `${'x'.repeat(130)}.one`;
    const other = `${'x'.repeat(130)}.two`;
    const codec = encodeToolNames({ tools: [{ name: long }, { name: other }] });
    const names = wireNames(codec);
    for (const name of names) expect(name).toMatch(WIRE);
    expect(names[0]).not.toBe(names[1]);
    expect(codec?.names.get(names[0] ?? '')).toBe(long);
  });

  test('random names always leave valid and come back unchanged', () => {
    const alphabet = 'ab._-:/ Z9';
    for (let round = 0; round < 300; round++) {
      const tools = Array.from({ length: 1 + (round % 6) }, (_, index) => ({
        name:
          Array.from(
            { length: 1 + ((round * 7 + index * 3) % 9) },
            (_, at) => alphabet[(round * 31 + index * 17 + at * 13) % alphabet.length],
          ).join('') || 'x',
      }));
      const codec = encodeToolNames({ tools });
      if (!codec) {
        for (const tool of tools) expect(tool.name).toMatch(WIRE);
        continue;
      }
      const wire = wireNames(codec);
      for (const name of wire) expect(name).toMatch(WIRE);
      const decode = toolNameDecoder(codec.names);
      wire.forEach((name, index) => {
        const reply = JSON.stringify({ type: 'tool_use', name });
        expect(JSON.parse(decode(reply)).name).toBe(tools[index]?.name);
      });
    }
  });
});

describe('the reply gets the engine names back', () => {
  const names = new Map([
    ['web__search', 'web.search'],
    ['run__finish', 'run.finish'],
  ]);

  test('a whole JSON reply', () => {
    const reply = JSON.stringify({
      content: [
        { type: 'text', text: 'I will use "name":"web__search" next' },
        { type: 'tool_use', id: 'toolu_1', name: 'web__search', input: { name: 'web__search' } },
      ],
    });
    const decoded = JSON.parse(toolNameDecoder(names)(reply));
    expect(decoded.content[1].name).toBe('web.search');
    // Text the model wrote keeps it; a `name` field in a call's input that
    // names a renamed tool means that tool, so it gets the engine's name too.
    expect(decoded.content[0].text).toBe('I will use "name":"web__search" next');
    expect(decoded.content[1].input).toEqual({ name: 'web.search' });
  });

  test('a stream split anywhere, even inside a name', () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"web__search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\"web__search\\"}"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"run__finish","input":{}}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join('');
    for (let size = 1; size <= 40; size++) {
      const stream = new ToolNameStream(names);
      let out = '';
      for (let at = 0; at < events.length; at += size)
        out += stream.push(events.slice(at, at + size));
      out += stream.end();
      expect(out).toBe(
        events
          .replace('"name":"web__search","input"', '"name":"web.search","input"')
          .replace('"name":"run__finish"', '"name":"run.finish"'),
      );
    }
  });
});
