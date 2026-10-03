import { describe, expect, test } from 'bun:test';
import {
  nullable,
  replyOf,
  StructuredAnswerError,
  strictObject,
  supportsStructuredOutput,
  withoutNulls,
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
      type: ['string', 'null'],
      enum: ['a', null],
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
