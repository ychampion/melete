import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeToolNames, ToolNameStream, toolNameDecoder, toolWireName } from './tool-names.ts';

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
    const search = `web__search_${createHash('sha256').update('web.search').digest('hex').slice(0, 8)}`;
    const finish = toolWireName('run.finish');
    expect(toolWireName('web.search')).toBe(search);
    expect(body.tools.map((tool) => tool.name)).toEqual([search, 'terminal', 'web_search']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: search });
    const calls = body.messages[1]?.content as { type: string; name?: string; text?: string }[];
    expect(calls.map((block) => block.name)).toEqual([undefined, search, finish]);
    // The model's own words and a server tool keep theirs.
    expect(calls[0]?.text).toBe('Calling web.search now.');
    expect(body.messages[2]).toEqual(original.messages[2]);
    // The engine's body is not touched, so a retry starts from the same request.
    expect(original).toEqual(snapshot);
    expect([...(codec?.names ?? [])]).toEqual([
      [search, 'web.search'],
      [finish, 'run.finish'],
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

describe("a wire name is the name's alone", () => {
  const definitions = (names: string[]) => names.map((name) => ({ name, input_schema: {} }));
  const mapping = (codec: ReturnType<typeof encodeToolNames>) =>
    new Map([...(codec?.names ?? [])].map(([wire, name]) => [name, wire]));

  test('the order of the tools and the other tools sent change no name', () => {
    const tools = ['web.search', 'run.finish', 'files.read', 'terminal', 'mcp:github/issues'];
    const first = mapping(encodeToolNames({ tools: definitions(tools) }));
    const reversed = mapping(encodeToolNames({ tools: definitions([...tools].reverse()) }));
    const fewer = mapping(encodeToolNames({ tools: definitions(['files.read']) }));
    expect(reversed).toEqual(first);
    expect(fewer.get('files.read')).toBe(first.get('files.read'));
    for (const [name, wire] of first) expect(wire).toBe(toolWireName(name));
  });

  test('a history that called a tool literally named a__b changes nothing for a.b', () => {
    const plain = mapping(encodeToolNames({ tools: definitions(['a.b']) }));
    const withHistory = encodeToolNames({
      tools: definitions(['a.b']),
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'a__b', input: {} },
            { type: 'tool_use', id: 't2', name: 'a.b', input: {} },
          ],
        },
      ],
    });
    expect(mapping(withHistory)).toEqual(plain);
    if (!withHistory) throw new Error('expected a.b to be renamed');
    const calls = (withHistory.body.messages as { content: { name: string }[] }[])[0]?.content;
    expect(calls?.map((call) => call.name)).toEqual(['a__b', toolWireName('a.b')]);
    expect(withHistory.names.has('a__b')).toBe(false);
  });

  test("a tool sent as it is that already has a wire name's spelling keeps it, and the renamed one moves", () => {
    const clash = toolWireName('a.b');
    const codec = encodeToolNames({ tools: definitions(['a.b', clash]) });
    const wire = mapping(codec).get('a.b') ?? '';
    expect(wire).not.toBe(clash);
    expect(wire).toBe(toolWireName('a.b', 16));
    expect(wireNamesOf(codec)).toEqual([wire, clash]);
    // Whatever the order.
    expect(mapping(encodeToolNames({ tools: definitions([clash, 'a.b']) })).get('a.b')).toBe(wire);
    // Even one made to match every length of the digest gets a distinct name.
    const all = [8, 16, 24, 32, 40, 48, 56, 64].map((digits) => toolWireName('a.b', digits));
    const cornered = mapping(encodeToolNames({ tools: definitions(['a.b', ...all]) }));
    expect(all).not.toContain(cornered.get('a.b'));
    expect(cornered.get('a.b')).toMatch(WIRE);
  });

  test('2,000 random rounds: valid, distinct, stable, exact both ways, inputs untouched', () => {
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
    const alphabet = 'ab._-:/ Z9é"\\';
    const word = () =>
      Array.from({ length: 1 + Math.floor(random() * (random() < 0.05 ? 160 : 10)) }, () =>
        pick([...alphabet]),
      ).join('');
    let clashes = 0;
    for (let round = 0; round < 2000; round++) {
      const pool = Array.from({ length: 1 + Math.floor(random() * 6) }, word);
      // A history may call any name, including one already spelled like a wire name.
      const history = Array.from({ length: Math.floor(random() * 4) }, () =>
        random() < 0.3 && pool.length
          ? toolWireName(pick(pool)).slice(0, 12)
          : pick([...pool, 'a__b', 'x_y']),
      );
      const body = {
        tools: definitions([...pool].sort(() => random() - 0.5)),
        messages: [
          {
            role: 'assistant',
            content: history.map((name, index) => ({
              type: 'tool_use',
              id: `t${index}`,
              name,
              input: { name: toolWireName(name) },
            })),
          },
        ],
      };
      const codec = encodeToolNames(body);
      const sent = [...pool, ...history];
      const valid = new Set(sent.filter((name) => WIRE.test(name)));
      if (!codec) {
        for (const name of sent) expect(name).toMatch(WIRE);
        continue;
      }
      const wires = [...codec.names.keys()];
      expect(new Set(wires).size).toBe(wires.length);
      for (const [wire, name] of codec.names) {
        expect(wire).toMatch(WIRE);
        expect(valid.has(wire)).toBe(false);
        // The name's own wire name, whatever else the request carries, unless a tool sent as it
        // is already has that spelling.
        if (valid.has(toolWireName(name))) clashes++;
        else expect([name, wire]).toEqual([name, toolWireName(name)]);
      }
      // Decoded whole and streamed, split anywhere, each call gets back exactly its name and
      // keeps its input.
      const calls =
        (codec.body.messages as { content: Record<string, unknown>[] }[])[0]?.content ?? [];
      const reply = JSON.stringify({ content: calls });
      const whole = JSON.parse(toolNameDecoder(codec.names)(reply)) as { content: Block[] };
      expect(whole.content).toEqual(body.messages[0]?.content ?? []);
      const events = calls
        .map(
          (call, index) =>
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { ...call, input: {} } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })}\n\n`,
        )
        .join('');
      const stream = new ToolNameStream(codec.names);
      let out = '';
      for (let at = 0; at < events.length; ) {
        const size = 1 + Math.floor(random() * 50);
        out += stream.push(events.slice(at, at + size));
        at += size;
      }
      out += stream.end();
      const data = out
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as Block);
      const started = data.filter((event) => event.type === 'content_block_start');
      expect(started.map((event) => (event.content_block as Block).name)).toEqual(history);
      const inputs = data.filter((event) => event.type === 'content_block_delta');
      expect(
        inputs.map((event) => JSON.parse((event.delta as Block).partial_json as string)),
      ).toEqual(calls.map((call) => call.input));
    }
    // Some rounds sent a tool spelled like another's wire name, so the clash path ran too.
    expect(clashes).toBeGreaterThan(0);
  });
});

type Block = Record<string, unknown>;

function wireNamesOf(codec: ReturnType<typeof encodeToolNames>): string[] {
  return ((codec?.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
}

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
    // Text the model wrote keeps it, and so does a call's input: what the model
    // passed to a tool is the tool's, and a streamed reply, whose input arrives
    // as a string of JSON, could not be changed the same way.
    expect(decoded.content[0].text).toBe('I will use "name":"web__search" next');
    expect(decoded.content[1].input).toEqual({ name: 'web__search' });
  });

  test("whole and streamed replies agree, and neither changes a call's input", () => {
    const input = {
      name: 'web__search',
      nested: { name: 'run__finish', list: [{ name: 'web__search' }] },
    };
    const whole = JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'web__search', input }],
    });
    const decoded = JSON.parse(toolNameDecoder(names)(whole));
    expect(decoded.content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'web.search',
      input,
    });
    const events = [
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web__search', input: {} } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    ].join('');
    const stream = new ToolNameStream(names);
    const out = stream.push(events) + stream.end();
    const data = out
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(data[0].content_block.name).toBe('web.search');
    expect(JSON.parse(data[1].delta.partial_json)).toEqual(input);
  });

  test('every byte but a renamed name is kept, numbers past double precision included', () => {
    const reply =
      '{ "content" : [ {"type":"tool_use","id":"t","name" : "web__search","input":{"n":12345678901234567890123,"f":1.50}} ], "usage":{"x":1e400} }';
    expect(toolNameDecoder(names)(reply)).toBe(reply.replace('"web__search"', '"web.search"'));
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
