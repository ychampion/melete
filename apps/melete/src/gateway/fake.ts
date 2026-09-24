import { object } from './metering.ts';
import type { GatewayProtocol, GatewayProvider } from './types.ts';

export type FakeTurn =
  | { tool: { name: string; arguments: Record<string, unknown>; id?: string }; text?: string }
  | { text: string; tool?: never };

export const fakeProvider: GatewayProvider = {
  name: 'fake',
  baseUrl: 'https://fake.melete.invalid/v1/',
  protocols: ['chat/completions', 'responses', 'messages'],
  fake: true,
};

const defaultScript: FakeTurn[] = [
  { tool: { name: 'test.send', arguments: { message: 'scripted hello' }, id: 'call_scripted_1' } },
  { text: 'This is a walkthrough answer from the scripted model.' },
];

/** Each attempt owns a script cursor; no provider call or API key is involved. */
export function createScriptedProvider(script: readonly FakeTurn[] = defaultScript) {
  const turns = new Map<string, number>();
  return async (body: Record<string, unknown>, attemptId: string, protocol: GatewayProtocol) => {
    const index = turns.get(attemptId) ?? 0;
    const turn = script[index];
    if (!turn)
      return Response.json({ error: { message: 'fake script exhausted' } }, { status: 409 });
    turns.set(attemptId, index + 1);
    const toolId = turn.tool?.id ?? `call_scripted_${index}`;
    const usage = {
      prompt_tokens: 12 + index * 5,
      completion_tokens: 8,
      total_tokens: 20 + index * 5,
    };
    const model = 'fake-scripted-v1';
    const message = {
      role: 'assistant',
      content: turn.text ?? null,
      ...(turn.tool
        ? {
            tool_calls: [
              {
                id: toolId,
                type: 'function',
                function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
              },
            ],
          }
        : {}),
    };
    if (protocol === 'responses') {
      const response = {
        id: `resp_fake_${index}`,
        object: 'response',
        status: 'completed',
        model,
        output: turn.tool
          ? [
              {
                type: 'function_call',
                id: toolId,
                call_id: toolId,
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
          output_tokens: 8,
          total_tokens: usage.total_tokens,
        },
      };
      return body.stream
        ? eventStream([{ type: 'response.completed', response }])
        : Response.json(response);
    }
    if (protocol === 'messages') {
      const response = {
        id: `msg_fake_${index}`,
        type: 'message',
        role: 'assistant',
        model,
        content: turn.tool
          ? [{ type: 'tool_use', id: toolId, name: turn.tool.name, input: turn.tool.arguments }]
          : [{ type: 'text', text: turn.text }],
        stop_reason: turn.tool ? 'tool_use' : 'end_turn',
        usage: { input_tokens: usage.prompt_tokens, output_tokens: 8 },
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
      id: `chatcmpl_fake_${index}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message, finish_reason: turn.tool ? 'tool_calls' : 'stop' }],
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
          choices: [{ index: 0, delta: {}, finish_reason: turn.tool ? 'tool_calls' : 'stop' }],
        },
        { id: response.id, model, choices: [], usage },
      ],
      true,
    );
  };
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
