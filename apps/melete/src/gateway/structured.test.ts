import { describe, expect, test } from 'bun:test';
import {
  hasStructuredOutput,
  namesSchema,
  nullable,
  replyOf,
  StructuredAnswerError,
  strictObject,
  stripStructuredOutput,
  supportsStructuredOutput,
  withoutNulls,
  withoutStructuredOutput,
  withStructuredOutput,
} from './structured.ts';

const format = { name: 'answer', schema: strictObject({ ok: { type: 'boolean' } }) };

describe('which providers hold an answer to a schema', () => {
  test('the hosted providers do; an unknown endpoint and early Claude models do not', () => {
    for (const [provider, model] of [
      ['openai', 'gpt-6-astra'],
      ['chatgpt', 'gpt-6-astra'],
      ['google', 'gemini-3-flash'],
      ['fireworks', 'accounts/fireworks/models/kimi'],
      ['anthropic', 'claude-opus-5-5'],
      ['anthropic', 'claude-haiku-4-5'],
      ['anthropic', 'claude-sonnet-4-5'],
    ])
      expect(supportsStructuredOutput(provider as string, model as string)).toBe(true);
    for (const [provider, model] of [
      ['openai-compatible', 'llama'],
      ['fake', 'scripted'],
      ['anthropic', 'claude-3-5-sonnet-20241022'],
      ['anthropic', 'claude-sonnet-4-20250514'],
      ['anthropic', 'claude-opus-4-0'],
    ])
      expect(supportsStructuredOutput(provider as string, model as string)).toBe(false);
  });

  test('each protocol carries the schema in its own field, strict', () => {
    const base = { model: 'm', max_tokens: 10 };
    expect(
      withStructuredOutput(base, { provider: 'openai', model: 'gpt-6-astra' }, 'responses', format),
    ).toEqual({
      ...base,
      text: {
        format: { type: 'json_schema', name: 'answer', schema: format.schema, strict: true },
      },
    });
    expect(
      withStructuredOutput(
        { ...base, output_config: { effort: 'low' } },
        { provider: 'anthropic', model: 'claude-opus-5-5' },
        'messages',
        format,
      ),
    ).toEqual({
      ...base,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: format.schema } },
    });
    expect(
      withStructuredOutput(base, { provider: 'google', model: 'g' }, 'chat/completions', format),
    ).toEqual({
      ...base,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: format.schema, strict: true },
      },
    });
    expect(
      withStructuredOutput(
        base,
        { provider: 'openai-compatible', model: 'x' },
        'chat/completions',
        format,
      ),
    ).toBe(base);
  });

  test('schema helpers build the strict subset', () => {
    expect(nullable({ type: 'string', enum: ['a'] })).toEqual({
      anyOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }],
    });
    expect(strictObject({ a: { type: 'string' } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(withoutNulls({ a: null, b: 1, c: null }, new Set(['c']))).toEqual({ b: 1, c: null });
  });
});

/** Every subschema in a schema, the schema itself included. */
function subschemas(schema: unknown): Record<string, unknown>[] {
  if (Array.isArray(schema)) return schema.flatMap(subschemas);
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const children = [
    ...Object.values((node.properties as Record<string, unknown> | undefined) ?? {}),
    node.items,
    node.anyOf,
  ];
  return [node, ...children.flatMap(subschemas)];
}

/**
 * The shape rules every provider holding the answer to a schema accepts:
 * Anthropic refuses an enum whose values do not all match every declared type,
 * and OpenAI strict mode wants every object closed with all of its properties
 * required.
 */
function providerSafe(schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const node of subschemas(schema)) {
    if (Array.isArray(node.enum)) {
      if (Array.isArray(node.type)) problems.push(`enum with a type list: ${JSON.stringify(node)}`);
      if (node.enum.includes(null)) problems.push(`null inside an enum: ${JSON.stringify(node)}`);
    }
    if (node.type === 'object') {
      const keys = Object.keys((node.properties as Record<string, unknown>) ?? {});
      if (node.additionalProperties !== false) problems.push('object left open');
      if (JSON.stringify(node.required) !== JSON.stringify(keys))
        problems.push(`object without every property required: ${keys.join(',')}`);
    }
  }
  return problems;
}

describe('nullable schema shapes', () => {
  test('an enum becomes a choice between the enum and null', () => {
    expect(
      nullable({ type: 'string', enum: ['user_statement', 'inferred'], description: 'why' }),
    ).toEqual({
      description: 'why',
      anyOf: [{ type: 'string', enum: ['user_statement', 'inferred'] }, { type: 'null' }],
    });
  });

  test('a plain field widens its type once', () => {
    expect(nullable({ type: 'string', description: 'note' })).toEqual({
      type: ['string', 'null'],
      description: 'note',
    });
    expect(nullable({ type: 'integer' })).toEqual({ type: ['integer', 'null'] });
    expect(nullable({ type: ['string', 'null'] })).toEqual({ type: ['string', 'null'] });
    expect(nullable({ type: ['array'], items: { type: 'string' } })).toEqual({
      type: ['array', 'null'],
      items: { type: 'string' },
    });
  });

  test('a nullable enum inside a strict object keeps the object strict', () => {
    const schema = strictObject({
      kind: nullable({ type: 'string', enum: ['a', 'b'] }),
      note: nullable({ type: 'string' }),
    });
    expect(providerSafe(schema)).toEqual([]);
  });

  test('the old enum shape is caught by the check', () => {
    expect(
      providerSafe(
        strictObject({ kind: { type: ['string', 'null'], enum: ['user_statement', null] } }),
      ),
    ).toHaveLength(2);
  });

  test('the service formats built with nullable are safe for every provider', async () => {
    const { EXTRACTION_FORMAT, ROOM_EXTRACTION_FORMAT } = await import('../memory/extract.ts');
    const { generalProposalFormat } = await import('../learning/proposal-gateway.ts');
    for (const format of [EXTRACTION_FORMAT, ROOM_EXTRACTION_FORMAT, generalProposalFormat()])
      expect({ name: format.name, problems: providerSafe(format.schema) }).toEqual({
        name: format.name,
        problems: [],
      });
  });
});

describe('how a reply ended', () => {
  test('chat completions: stop, length, a refusal', () => {
    const chat = (message: Record<string, unknown>, finish: string) => ({
      choices: [{ message, finish_reason: finish }],
    });
    expect(replyOf('chat/completions', chat({ content: '{}' }, 'stop'))).toEqual({
      text: '{}',
      end: 'complete',
    });
    expect(replyOf('chat/completions', chat({ content: '{"a":' }, 'length')).end).toBe('cut_off');
    expect(
      replyOf('chat/completions', chat({ content: null, refusal: 'I cannot help.' }, 'stop')),
    ).toEqual({ text: '', end: 'refused' });
  });

  test('messages: end_turn, max_tokens, refusal; tool use is ignored', () => {
    const reply = (stop: string) => ({
      content: [
        { type: 'tool_use', name: 'x', input: {} },
        { type: 'text', text: '{"ok":true}' },
      ],
      stop_reason: stop,
    });
    expect(replyOf('messages', reply('end_turn'))).toEqual({
      text: '{"ok":true}',
      end: 'complete',
    });
    expect(replyOf('messages', reply('max_tokens')).end).toBe('cut_off');
    expect(replyOf('messages', reply('refusal')).end).toBe('refused');
  });

  test('responses: completed, incomplete at the output limit, a refusal part', () => {
    const output = [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":' }] }];
    expect(replyOf('responses', { status: 'completed', output }).end).toBe('complete');
    expect(
      replyOf('responses', {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output,
      }),
    ).toEqual({ text: '{"ok":', end: 'cut_off' });
    expect(
      replyOf('responses', {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }],
      }).end,
    ).toBe('refused');
  });

  test('a body that is not the protocol’s is envelope_invalid', () => {
    for (const [protocol, body] of [
      ['responses', { choices: [] }],
      ['messages', { output: [] }],
      ['chat/completions', { content: [] }],
      ['chat/completions', 'text'],
    ] as const) {
      const error = (() => {
        try {
          replyOf(protocol, body);
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(error).toBeInstanceOf(StructuredAnswerError);
      expect((error as StructuredAnswerError).message).toBe('answer_envelope_invalid');
    }
  });
});

describe('a fallback without structured outputs', () => {
  test('is sent the request without its schema, everything else kept', () => {
    const target = { provider: 'openai-compatible', model: 'local' };
    expect(
      withoutStructuredOutput(
        { model: 'x', response_format: { type: 'json_schema' }, reasoning_effort: 'low' },
        target,
      ),
    ).toEqual({ model: 'x', reasoning_effort: 'low' });
    expect(
      withoutStructuredOutput(
        {
          model: 'x',
          text: { format: { type: 'json_schema' }, verbosity: 'low' },
          reasoning: { effort: 'low' },
        },
        target,
      ),
    ).toEqual({ model: 'x', text: { verbosity: 'low' }, reasoning: { effort: 'low' } });
    const kept = { model: 'x', response_format: { type: 'json_schema' } };
    expect(withoutStructuredOutput(kept, { provider: 'openai', model: 'gpt-6-astra' })).toBe(kept);
  });
});

describe('stop reasons that are not a whole answer', () => {
  test('a context window exhausted mid-answer is cut off; a failed response has no answer', () => {
    expect(
      replyOf('messages', {
        content: [{ type: 'text', text: '{"a":' }],
        stop_reason: 'model_context_window_exceeded',
      }).end,
    ).toBe('cut_off');
    for (const status of ['failed', 'cancelled'])
      expect(() => replyOf('responses', { status, output: [] })).toThrow('answer_envelope_invalid');
  });

  test('the schema joins whatever text settings the request already has', () => {
    expect(
      withStructuredOutput(
        { model: 'm', text: { verbosity: 'low' } },
        { provider: 'openai', model: 'gpt-6-astra' },
        'responses',
        format,
      ).text,
    ).toEqual({
      verbosity: 'low',
      format: { type: 'json_schema', name: 'answer', schema: format.schema, strict: true },
    });
  });

  test('stripping leaves plain JSON mode alone, and recognises schema 400s by their text', () => {
    const jsonMode = { model: 'x', response_format: { type: 'json_object' } };
    expect(stripStructuredOutput(jsonMode)).toEqual(jsonMode);
    expect(hasStructuredOutput(jsonMode)).toBe(false);
    for (const text of [
      "Invalid value at 'response_format.json_schema.schema'",
      'text.format: strict mode requires additionalProperties false',
      'output_config.format is not supported for this model',
    ])
      expect(namesSchema(text)).toBe(true);
    expect(namesSchema('Unrecognized request argument supplied: reasoning_effort')).toBe(false);
  });
});
