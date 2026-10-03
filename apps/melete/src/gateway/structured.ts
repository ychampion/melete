/**
 * Structured answers for the service's own side calls: memory extraction,
 * learning proposals, the action reviewer and the voice companion.
 *
 * Each of these asks a model for one JSON document. Asking in prose ("return
 * only JSON") fails in the ways models fail: an answer cut off by the output
 * limit, reasoning written before the JSON, a fence, a field of the model's
 * own. Where the provider can hold the answer to a schema (OpenAI and the
 * ChatGPT plan through `text.format` or `response_format`, Anthropic through
 * `output_config.format`, Gemini and Fireworks through `response_format`), the
 * request carries the call's schema and the reply is the document. Where it
 * cannot, the request is the plain one it always was and the caller's text
 * reader stays in use, behind the same interface.
 *
 * Either way the reply is still checked: the stop reason (an answer cut off at
 * the output limit or refused is never read as a whole one), then the JSON,
 * then the caller's own zod schema.
 */
import type { GatewayProtocol } from './types.ts';

/** A JSON Schema for one call, in the strict subset every supporting provider accepts. */
export type StructuredFormat = {
  /** Letters, digits, `_` and `-` only; providers show it in their logs. */
  name: string;
  schema: Record<string, unknown>;
};

/** Why a structured answer could not be used. Each is a separate line in health. */
export type StructuredFailure =
  /** The provider stopped at the output limit before the document was whole. */
  | 'cut_off'
  /** The provider declined to answer. */
  | 'refused'
  /** The reply's envelope was not the protocol's. */
  | 'envelope_invalid'
  /** The text was not one JSON document. */
  | 'not_json';

export class StructuredAnswerError extends Error {
  constructor(readonly reason: StructuredFailure) {
    super(`answer_${reason}`);
  }
}

/** Anthropic models from before structured outputs; every later one has them. */
const ANTHROPIC_WITHOUT = /^claude-(?:instant|2|3)|^claude-(?:opus|sonnet)-4(?:-0|-\d{8})?$/;

/**
 * Whether requests to this provider and model may carry a JSON schema.
 * An operator's own OpenAI-compatible endpoint may be anything, so it keeps
 * the plain request; so does a provider this table does not know.
 */
export function supportsStructuredOutput(provider: string, model: string): boolean {
  switch (provider) {
    case 'openai':
    case 'chatgpt':
    case 'google':
    case 'fireworks':
      return true;
    case 'anthropic':
      return !ANTHROPIC_WITHOUT.test(model);
    default:
      return false;
  }
}

/**
 * The request body with the schema added in the protocol's own field, or the
 * body unchanged when the provider has no structured outputs. Strict mode: the
 * provider holds every object to exactly the schema's keys.
 */
export function withStructuredOutput(
  body: Record<string, unknown>,
  target: { provider: string; model: string },
  protocol: GatewayProtocol,
  format: StructuredFormat,
): Record<string, unknown> {
  if (!supportsStructuredOutput(target.provider, target.model)) return body;
  if (protocol === 'responses')
    return {
      ...body,
      text: {
        format: { type: 'json_schema', name: format.name, schema: format.schema, strict: true },
      },
    };
  if (protocol === 'messages') {
    const config = (body.output_config as Record<string, unknown> | undefined) ?? {};
    return {
      ...body,
      output_config: { ...config, format: { type: 'json_schema', schema: format.schema } },
    };
  }
  return {
    ...body,
    response_format: {
      type: 'json_schema',
      json_schema: { name: format.name, schema: format.schema, strict: true },
    },
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How a reply ended: whole, cut off at the output limit, or refused. */
export type ReplyEnd = 'complete' | 'cut_off' | 'refused';

/**
 * The text of a provider reply and how it ended. Only text is read: a tool
 * call or reasoning item in the reply, if a model made one, is ignored.
 * Throws `envelope_invalid` when the reply is not the protocol's shape.
 */
export function replyOf(
  protocol: GatewayProtocol,
  result: unknown,
): { text: string; end: ReplyEnd } {
  if (!record(result)) throw new StructuredAnswerError('envelope_invalid');
  if (protocol === 'responses') {
    if (!Array.isArray(result.output)) throw new StructuredAnswerError('envelope_invalid');
    let refused = false;
    const parts: string[] = [];
    for (const item of result.output) {
      if (!record(item) || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!record(part)) continue;
        if (part.type === 'refusal') refused = true;
        if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      }
    }
    const details = record(result.incomplete_details) ? result.incomplete_details : null;
    const end: ReplyEnd = refused
      ? 'refused'
      : result.status === 'incomplete' && details?.reason !== 'content_filter'
        ? 'cut_off'
        : result.status === 'incomplete'
          ? 'refused'
          : 'complete';
    return { text: parts.join(''), end };
  }
  if (protocol === 'messages') {
    if (!Array.isArray(result.content)) throw new StructuredAnswerError('envelope_invalid');
    const text = result.content
      .filter((part) => record(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => (part as { text: string }).text)
      .join('');
    const end: ReplyEnd =
      result.stop_reason === 'max_tokens'
        ? 'cut_off'
        : result.stop_reason === 'refusal'
          ? 'refused'
          : 'complete';
    return { text, end };
  }
  const choice = Array.isArray(result.choices) ? result.choices[0] : undefined;
  if (!record(choice) || !record(choice.message))
    throw new StructuredAnswerError('envelope_invalid');
  const content = choice.message.content;
  if (content !== undefined && content !== null && typeof content !== 'string')
    throw new StructuredAnswerError('envelope_invalid');
  const end: ReplyEnd =
    typeof choice.message.refusal === 'string' && choice.message.refusal
      ? 'refused'
      : choice.finish_reason === 'length'
        ? 'cut_off'
        : choice.finish_reason === 'content_filter'
          ? 'refused'
          : 'complete';
  return { text: content ?? '', end };
}

/** A property that may also be null, for fields only some answers use. */
export const nullable = (schema: Record<string, unknown>): Record<string, unknown> => {
  const type = schema.type;
  return {
    ...schema,
    type: Array.isArray(type) ? [...type, 'null'] : [type, 'null'],
    ...(Array.isArray(schema.enum) ? { enum: [...schema.enum, null] } : {}),
  };
};

/** An object whose every listed property is required and nothing else is allowed. */
export const strictObject = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * A copy of a parsed answer without the properties the schema made nullable
 * and the model left null, so the caller's zod schema sees only what was said.
 * `keep` names properties whose null is meaningful.
 */
export function withoutNulls(value: unknown, keep: ReadonlySet<string> = new Set()): unknown {
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([name, child]) => child !== null || keep.has(name)),
  );
}
