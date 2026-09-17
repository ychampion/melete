/**
 * A scripted model that forces the engine to compact inside one attempt.
 *
 * The ordinary scripted provider in `fake.ts` answers a fixed list of turns and
 * reports a token count that never grows. Compaction is driven by reported
 * usage, so proving it needs a model whose prompt cost rises with the history:
 * every request is charged one token per four request bytes, and four large
 * reads push the reported prompt past any small threshold.
 *
 * The summary call is recognised by its shape rather than by a counter, because
 * it is issued out of band by the engine's auxiliary client and must not consume
 * a turn of the main script: a request that carries no tools and exactly one
 * user message holding the engine's summary preamble is a compaction summary.
 */
import { object } from './metering.ts';
import type { GatewayProtocol } from './types.ts';

/**
 * The opening of the summarizer preamble, byte-identical to the pinned engine
 * (`agent/context_compressor.py`, `_build_summary_prompt`). It is shared by the
 * fresh and the iterative-update prompt, so it identifies both.
 */
export const SUMMARY_PROMPT_MARKER = 'You are a summarization agent creating a context checkpoint.';

/** The body of the scripted summary; a later main request has to carry it. */
export const SCRIPTED_SUMMARY = 'SCRIPTED-SUMMARY-7f3a';

/**
 * What the scripted summary claims to cost. The engine asks for a summary of
 * up to min(5% of the window, 10,000) tokens and sends no limit of its own, so
 * a gateway that substitutes a smaller one truncates the answer. A real
 * provider reports that as a `length` stop and the engine treats the summary as
 * failed; this script reports it the same way rather than pretending a
 * truncated request produced a whole summary.
 */
export const SUMMARY_OUTPUT_TOKENS = 3200;

/** The reads the script asks for, in order. The caller writes the fixtures. */
export const COMPACTION_FIXTURES = [
  'fixture-1.txt',
  'fixture-2.txt',
  'fixture-3.txt',
  'fixture-4.txt',
] as const;

export type CompactionCall = {
  /** `summary` is the auxiliary compaction call; every other call is `main`. */
  kind: 'main' | 'summary';
  /** Bytes of the request as the gateway forwarded it. */
  bytes: number;
  /** Whether the history this request carries already holds the summary. */
  carriesSummary: boolean;
  /** The output limit the request arrived with, or null when it named none. */
  grantedOutputTokens: number | null;
  /** How the script answered: `length` means the granted limit truncated it. */
  finish: 'stop' | 'tool_calls' | 'length';
};

export interface CompactionScript {
  (body: Record<string, unknown>, attemptId: string, protocol: GatewayProtocol): Promise<Response>;
  /** Every call the gateway let through, in the order it forwarded them. */
  readonly calls: CompactionCall[];
}

function messages(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body.messages;
  return Array.isArray(value)
    ? value.map(object).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

/** Content arrives either as a string or as the typed-block form. */
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const block = object(part);
      const value = block?.text ?? block?.content;
      return typeof value === 'string' ? value : '';
    })
    .join('\n');
}

function isSummaryRequest(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (Array.isArray(tools) ? tools.length > 0 : tools !== undefined) return false;
  const rows = messages(body);
  const users = rows.filter((row) => row.role === 'user');
  if (rows.length !== 1 || users.length !== 1) return false;
  return text(users[0]?.content).includes(SUMMARY_PROMPT_MARKER);
}

function grantedOutputTokens(body: Record<string, unknown>): number | null {
  for (const key of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The script: four reads, then a closing text turn. The turn cursor belongs to
 * the attempt, so a second attempt starts at the first read again.
 */
export function createCompactionScript(
  fixtures: readonly string[] = COMPACTION_FIXTURES,
): CompactionScript {
  const turns = new Map<string, number>();
  const calls: CompactionCall[] = [];
  const script: CompactionScript = Object.assign(
    async (body: Record<string, unknown>, attemptId: string, protocol: GatewayProtocol) => {
      const encoded = JSON.stringify(body);
      const bytes = Buffer.byteLength(encoded, 'utf8');
      // One token per four request bytes: a plain, monotone cost the engine's
      // threshold can be set against without guessing a tokenizer.
      const promptTokens = Math.ceil(bytes / 4);
      const granted = grantedOutputTokens(body);
      const carriesSummary = encoded.includes(SCRIPTED_SUMMARY);
      if (isSummaryRequest(body)) {
        // A granted limit below what the summary needs truncates it, exactly as
        // a real provider would, and the engine reads that as a failed summary.
        const truncated = granted !== null && granted < SUMMARY_OUTPUT_TOKENS;
        calls.push({
          kind: 'summary',
          bytes,
          carriesSummary,
          grantedOutputTokens: granted,
          finish: truncated ? 'length' : 'stop',
        });
        return answer(protocol, body, {
          text: truncated ? SCRIPTED_SUMMARY.slice(0, 8) : summaryBody(),
          finish: truncated ? 'length' : 'stop',
          index: calls.length - 1,
          promptTokens,
          completionTokens: truncated ? (granted ?? 0) : SUMMARY_OUTPUT_TOKENS,
        });
      }
      const index = turns.get(attemptId) ?? 0;
      turns.set(attemptId, index + 1);
      const fixture = fixtures[index];
      calls.push({
        kind: 'main',
        bytes,
        carriesSummary,
        grantedOutputTokens: granted,
        finish: fixture ? 'tool_calls' : 'stop',
      });
      if (!fixture) {
        return answer(protocol, body, {
          text: 'Read every fixture and finished.',
          finish: 'stop',
          index,
          promptTokens,
          completionTokens: 8,
        });
      }
      return answer(protocol, body, {
        tool: { name: 'files.read', arguments: { path: fixture }, id: `call_compaction_${index}` },
        finish: 'tool_calls',
        index,
        promptTokens,
        completionTokens: 8,
      });
    },
    { calls },
  );
  return script;
}

/** A summary in the shape the engine's own template asks for. */
function summaryBody(): string {
  return [
    '## Historical Task',
    SCRIPTED_SUMMARY,
    '',
    '## Goal',
    'Read the fixtures and finish.',
    '',
    '## Completed Actions',
    '1. READ the fixtures — scripted content [tool: files.read]',
    '',
    '## Active State',
    'The remaining fixtures are still to be read.',
  ].join('\n');
}

type Turn = {
  text?: string;
  tool?: { name: string; arguments: Record<string, unknown>; id: string };
  finish: 'stop' | 'tool_calls' | 'length';
  index: number;
  promptTokens: number;
  completionTokens: number;
};

function answer(protocol: GatewayProtocol, body: Record<string, unknown>, turn: Turn): Response {
  const usage = {
    prompt_tokens: turn.promptTokens,
    completion_tokens: turn.completionTokens,
    total_tokens: turn.promptTokens + turn.completionTokens,
  };
  const model = 'fake-compaction-v1';
  const message = {
    role: 'assistant',
    content: turn.text ?? null,
    ...(turn.tool
      ? {
          tool_calls: [
            {
              id: turn.tool.id,
              type: 'function',
              function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
            },
          ],
        }
      : {}),
  };
  if (protocol === 'responses') {
    const response = {
      id: `resp_compaction_${turn.index}`,
      object: 'response',
      status: 'completed',
      model,
      output: turn.tool
        ? [
            {
              type: 'function_call',
              id: turn.tool.id,
              call_id: turn.tool.id,
              name: turn.tool.name,
              arguments: JSON.stringify(turn.tool.arguments),
            },
          ]
        : [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: turn.text }],
            },
          ],
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
    };
    return body.stream
      ? eventStream([{ type: 'response.completed', response }])
      : Response.json(response);
  }
  if (protocol === 'messages') {
    const response = {
      id: `msg_compaction_${turn.index}`,
      type: 'message',
      role: 'assistant',
      model,
      content: turn.tool
        ? [{ type: 'tool_use', id: turn.tool.id, name: turn.tool.name, input: turn.tool.arguments }]
        : [{ type: 'text', text: turn.text }],
      stop_reason:
        turn.finish === 'tool_calls'
          ? 'tool_use'
          : turn.finish === 'length'
            ? 'max_tokens'
            : 'end_turn',
      usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
    };
    return body.stream
      ? eventStream([
          { type: 'message_start', message: { ...response, content: [] } },
          { type: 'content_block_start', index: 0, content_block: response.content[0] },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: response.stop_reason },
            usage: response.usage,
          },
          { type: 'message_stop' },
        ])
      : Response.json(response);
  }
  const response = {
    id: `chatcmpl_compaction_${turn.index}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: turn.finish }],
    usage,
  };
  if (!body.stream) return Response.json(response);
  const tool = object(message.tool_calls?.[0]);
  return eventStream(
    [
      {
        id: response.id,
        object: 'chat.completion.chunk',
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              ...(tool ? { tool_calls: [{ index: 0, ...tool }] } : { content: turn.text }),
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: response.id,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: turn.finish }],
      },
      { id: response.id, model, choices: [], usage },
    ],
    true,
  );
}

function eventStream(events: unknown[], done = false): Response {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (done) chunks.push('data: [DONE]\n\n');
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
  );
}
